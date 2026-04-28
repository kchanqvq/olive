import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ReplView } from './replView';
import { DebugView } from './debugView';
import { plistGet, severityOrder, convertCompilerNote, searchBufferPackage, getSymbol, getLastExpression,
    convertCompletionItem, convertDefinition, convertDescribeSymbol, convertIndentSpec } from './subr';
import * as indent from './indent';
const { Client, util } = require('swank-client');
const paredit = require('paredit.js');

const evalDecorationType = vscode.window.createTextEditorDecorationType({
    after: {margin: '0 0 0 2em',
        color: new vscode.ThemeColor('editorCodeLens.foreground')},
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    isWholeLine: true
})

export class LispSession implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider, vscode.CompletionItemProvider, vscode.HoverProvider, vscode.DefinitionProvider {
    public client: any;
    public clientReady: Boolean = false;
    private lispProcess: cp.ChildProcess | undefined;
    private lispOutputChannel: vscode.OutputChannel | undefined;
    private statusBarItem: vscode.StatusBarItem;
    private debugViews = new Map<string, DebugView>();
    public diagnostics: vscode.DiagnosticCollection;

    constructor(private ctx: vscode.ExtensionContext,
        private replProvider: ReplView,
        // package -> symbol -> indent.IndentSpec
        private systemSpecs: Map<string, Map<string, indent.IndentSpec>>) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'olive.startLisp';
        this.statusDisconnected();
        this.statusBarItem.show();
        ctx.subscriptions.push(this.statusBarItem);

        this.diagnostics = vscode.languages.createDiagnosticCollection('lisp');
        ctx.subscriptions.push(this.diagnostics);

        ctx.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
            const editor = vscode.window.activeTextEditor;
            if (editor && e.document === editor.document) {
                editor.setDecorations(evalDecorationType, []);
            }
        }));

        this.registerCommands();
    }

    private registerCommands() {
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.connect', () => this.connect()));
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.startLisp', () => this.startLisp()));
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.disconnect', () => this.disconnect()));
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.interrupt', () => this.interrupt()));
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.evaluating', () => vscode.commands.executeCommand('olive.interrupt')));
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.clearRepl', () => this.replProvider.clear()));
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.syncRepl', () => this.syncRepl()));
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.setReplPackage', () => this.replProvider.setPackage()));
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.compileFile', () => this.compileFile()));
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.compileFileDebug', () => this.compileFile(":POLICY '((CL:DEBUG . 3))")));
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.evalLastExpression', () => this.evalLastExpression()));
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.loadWorkspaceSystem', () => this.loadWorkspaceSystem()));
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.indentLine', () => this.indentLine()));
        this.ctx.subscriptions.push(vscode.commands.registerCommand('olive.newlineAndIndent', () => this.newlineAndIndent()));

        this.ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('editor')) this.replProvider.sendSettings();
        }));
    }

    private checkClient() {
        if (!this.client) {
            vscode.window.showErrorMessage('Not connected to a Swank server');
            return false;
        } else if (!this.clientReady) {
            vscode.window.showErrorMessage('Connection to Swank server not fully established');
            return false;
        }
        return true;
    }

    private async maybeDisconnect() {
        if (this.client) {
            const choice = await vscode.window.showInformationMessage(
                `A client is already ${this.clientReady ? 'connected' : 'connecting'}. Disconnect it?`, { modal: true }, 'Disconnect');
            if (choice !== 'Disconnect') return false;
            this.client?.disconnect();
        }
        return true;
    }

    public async connect() {
        if (!await this.maybeDisconnect()) return;

        const host = await vscode.window.showInputBox({ prompt: 'Host', value: 'localhost' });
        if (!host) return;
        const portStr = await vscode.window.showInputBox({ prompt: 'Port', value: '4005' });
        if (!portStr) return;

        await this.connectTo(host, parseInt(portStr));
    }

    public async startLisp() {
        const config = vscode.workspace.getConfiguration('olive');
        const lispCommand = config.get<string>('lispCommand') || 'sbcl';
        
        if (this.lispProcess) {
            const choice = await vscode.window.showInformationMessage('A Lisp process is already running. Quit it?', { modal: true }, 'Quit');
            if (choice !== 'Quit') return;
            await this.quitLisp();
            // Guard, so that in case multiple startLisp command runs and
            // reaches here, only one continues.  This is madness, I hope it
            // works...
            if (this.lispProcess) return;
        } else if (!await this.maybeDisconnect()) return;

        if (!this.lispOutputChannel) {
            this.lispOutputChannel = vscode.window.createOutputChannel('Lisp process');
        }
        this.lispOutputChannel.clear();
        this.lispOutputChannel.show(true);
        this.statusConnecting();
        const portFile = path.join(os.tmpdir(), `olive-port.${process.pid}`);

        try {
            if (fs.existsSync(portFile)) fs.unlinkSync(portFile);

            const swankLoader = path.join(this.ctx.extensionPath, 'slime', 'swank-loader.lisp');
            const lispCode = `
(LOAD ${JSON.stringify(swankLoader)})
(SWANK-LOADER:INIT :FROM-EMACS T)
(SWANK:START-SERVER ${util.to_lisp_string(portFile)})
`;

            this.lispProcess = cp.spawn(lispCommand, {
                cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
                env: process.env
            });

            this.lispProcess.stdout?.on('data', (data) => this.lispOutputChannel?.append(data.toString()));
            this.lispProcess.stderr?.on('data', (data) => this.lispOutputChannel?.append(data.toString()));
            this.lispProcess.on('exit', (code) => {
                this.lispOutputChannel?.appendLine(`\nLisp process exited with code ${code}`);
                this.lispProcess = undefined;
            });

            this.lispProcess.stdin?.write(lispCode);

            // Poll Swank port file
            let port: number | undefined;
            for (let i = 0; i < 50; i++) {
                if (fs.existsSync(portFile)) {
                    try {
                        const content = fs.readFileSync(portFile, 'utf8').trim();
                        if (content.length > 0) {
                            const p = parseInt(content);
                            if (!isNaN(p)) {
                                port = p;
                                break;
                            }
                        }
                    } catch (e) {}
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            if (!port) {
                throw new Error('Timeout waiting for Swank port file');
            }

            fs.unlinkSync(portFile);
            await this.connectTo('localhost', port);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to start Lisp: ${err.message || err}`);
            this.statusDisconnected();
            if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
            this.lispProcess?.kill();
        }
    }

    public async quitLisp() {
        if (!this.lispProcess) {
            vscode.window.showErrorMessage('No Lisp process');
            return;
        }
        const exited = new Promise(resolve => this.lispProcess?.on('exit', resolve));
        // We might not be able to quit gracefully if lispProcess started but
        // swank-client has not yet connected
        if (this.clientReady) {
            this.client.rex('(SWANK:QUIT-LISP)');
            this.lispProcess.stdin?.end();
            await new Promise(res => setTimeout(res, 200));
        }
        if (!this.lispProcess?.exitCode)
            this.lispProcess?.kill();
        await exited;
    }

    public disconnect() {
        if (!this.client) {
            vscode.window.showErrorMessage('Not connected to a Swank server');
            return;
        }
        this.client?.disconnect();
    }

    public interrupt() {
        if (!this.checkClient()) return;
        this.client?.interrupt();
    }

    public async connectTo(host: string, port: number) {
        try {
            this.statusConnecting();
            this.client = new Client(host, port);
            
            await this.client.connect();
            
            this.client.on('disconnect', () => {
                this.clientReady = false;
                this.client = undefined;
                this.statusDisconnected();
                this.debugViews.forEach(v => {
                    v.isHandled = true;
                    v.panel.dispose();
                });
                this.debugViews.clear();
                this.replProvider.setClient(undefined, undefined);
            });

            this.client.on('debug_setup', (info: any) => {
                const view = this.debugViews.get(info.thread);
                if (view) {
                    view.setup(info);
                }
                else {
                    this.debugViews.set(info.thread, new DebugView(this.ctx, info, this.client));
                }
            });

            this.client.on('debug_return', (info: any) => {
                const view = this.debugViews.get(info.thread);
                if (view) {
                    view.isHandled = true;
                    view.panel.dispose();
                    this.debugViews.delete(info.thread);
                }
            });

            this.client.on('indentation_update', (info: any) => {
                for (const item of info.children){
                    const symbol = util.from_lisp_string(item.children[0]);
                    const indentSpec = convertIndentSpec(item.children[1]);
                    for (const pkgSexp of item.children[2].children){
                        const pkg = util.from_lisp_string(pkgSexp);
                        if (!this.systemSpecs.has(pkg)) this.systemSpecs.set(pkg, new Map());
                        const specMap = this.systemSpecs.get(pkg);
                        specMap?.set(symbol, indentSpec);
                    }
                }
                this.replProvider.sendSpecs();
            });

            const events = ['presentation_start', 'presentation_end', 'debug_activate', 'read_from_minibuffer', 'y_or_n_p', 'read_aborted', 'profile_command_complete'];
            events.forEach(e => this.client.on(e, (...args: any[]) => console.log(`Swank event: ${e}`, ...args)));

            
            const info = await this.client.initialize();

            this.clientReady = true;
            this.statusConnected();
            this.replProvider.setClient(this.client, info);
            // hack: reveal REPL view and return focus
            await vscode.commands.executeCommand('olive.replView.focus')
            await vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
        } catch (err) {
            this.statusDisconnected();
            vscode.window.showErrorMessage(`Failed to connect: ${err}`);
        }
    }

    private statusDisconnected() {
        this.statusBarItem.text = "$(debug-disconnect) Olive: Disconnected";
        this.statusBarItem.tooltip = "Start lisp process"
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }

    private statusConnecting() {
        this.statusBarItem.text = "$(sync~spin) Olive: Connecting...";
        this.statusBarItem.tooltip = "Restart lisp process"
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    private statusConnected() {
        this.statusBarItem.text = "$(check) Olive: Connected";
        this.statusBarItem.tooltip = "Restart lisp process"
        this.statusBarItem.backgroundColor = undefined;
    }

    public dispose() {
        this.client?.disconnect();
        this.lispProcess?.kill();
    }

    public async compileFile(options: string = '') {
        if (!this.checkClient()) return;

        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const doc = editor.document;
        if (doc.isDirty) await doc.save();

        const fileName = doc.fileName;

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Compiling ${path.basename(fileName)}...`,
                cancellable: false
            }, async (progress) => {
                const cmd = `(SWANK:COMPILE-FILE-FOR-EMACS ${util.to_lisp_string(fileName)} T ${options})`;
                const res = await this.client.rex(cmd, 'COMMON-LISP-USER', 'T');

                if (res.type === 'list') {
                    const success = util.from_lisp_bool(res.children[2]);
                    const duration = Number(res.children[3].source);
                    const faslfile = util.from_lisp_bool(res.children[5]) && util.from_lisp_string(res.children[5]);

                    const msgParts = [success ? "Compilation finished" : "Compilation failed"];
                    if (util.from_lisp_bool(res.children[1])) {
                        const notes = res.children[1].children;
                        const noteCounts: Map<string, number> = new Map(severityOrder.map(s => [s, 0]));
                        for (const note of notes) {
                            let severity = plistGet(note, ':severity').source.slice(1).toLowerCase();
                            noteCounts.set(severity, (noteCounts.get(severity) || 0) + 1);
                        }

                        msgParts.push(": ");
                        for (const [severity, count] of noteCounts) {
                            if (count > 0) {
                                msgParts.push(`${count} ${severity}${count > 1 ? 's' : ''}  `);
                            }
                        }

                        this.diagnostics.set(doc.uri,
                            notes.map((n: any) => convertCompilerNote(doc, n)));

                    } else {
                        msgParts.push(". (No warnings)  ");
                        this.diagnostics.set(doc.uri, []);
                    }

                    msgParts.push(`[${duration.toFixed(2)} secs]`);

                    (success ? vscode.window.showInformationMessage : vscode.window.showErrorMessage)(
                        msgParts.join(""));
                    if (faslfile &&
                        (success ||
                            await vscode.window.showInformationMessage('Compilation failed. Load fasl file anyway?',
                                { modal: true }, 'Load') === 'Load'))
                        this.client.rex(`(SWANK:LOAD-FILE ${util.to_lisp_string(faslfile)})`, 'COMMON-LISP-USER', 'T');
                }
                else
                    vscode.window.showErrorMessage(`Compilation failed: ${util.from_lisp_string(res)}`);
            });
        } catch (err) {
            vscode.window.showErrorMessage(`Compilation failed: ${err}`);
        }
    }

    public async evalLastExpression() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.checkClient()) return;

        const doc = editor.document, pos = editor.selection.active;
        const range = getLastExpression(doc, pos);
        if (!range) return;

        const pkg = searchBufferPackage(doc, pos);
        const code = doc.getText(range);

        editor.setDecorations(evalDecorationType, []);
        try {
            const res = await this.client.rex(`(SWANK:INTERACTIVE-EVAL ${util.to_lisp_string(code)} 1 40)`, pkg, ':REPL-THREAD');
            const resultStr = util.from_lisp_string(res);
            const lineEnd = doc.lineAt(pos.line).range.end;

            editor.setDecorations(evalDecorationType, [{
                range: new vscode.Range(lineEnd, lineEnd),
                renderOptions: {after: {contentText: '; ' + resultStr}}}]);
        } catch (err) {
            vscode.window.showErrorMessage(`Evaluation failed: ${err}`);
        }
    }

    public async loadWorkspaceSystem() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('Cannot find workspace root directory.');
            return;
        }

        const asdFiles = await vscode.workspace.findFiles('**/*.asd', '**/node_modules/**');
        if (asdFiles.length === 0) {
            vscode.window.showErrorMessage('No .asd file found in workspace root directory.')
            return;
        }

        // Some heurstics to guess ASD system/file
        const workspaceFolderName = path.basename(workspaceRoot);
        asdFiles.sort((a, b) => {
            const aName = path.basename(a.fsPath, '.asd');
            const bName = path.basename(b.fsPath, '.asd');
            if (aName === workspaceFolderName) return -1;
            if (bName === workspaceFolderName) return 1;
            return aName.localeCompare(bName);
        });

        const winner = asdFiles.at(-1)?.fsPath as string;
        await this.loadSystem(path.basename(winner, '.asd'), winner);
    }

    public async syncRepl() {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const doc = editor.document, uri = doc.uri;
            if (uri.scheme === 'file') {
                const dir = path.dirname(uri.fsPath);
                await this.client.rex(`(SWANK:SET-DEFAULT-DIRECTORY (UIOP:PARSE-NATIVE-NAMESTRING ${util.to_lisp_string(dir)}))`,
                    'COMMON-LISP-USER', ':REPL-THREAD');
            }
            if (doc.languageId === 'common-lisp') {
                this.replProvider.setPackage(searchBufferPackage(doc, editor.selection.active));
            }
        }
    }

    public async loadSystem(systemName: string, systemFile?: string){
        if (!this.checkClient()) return;
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Loading system ${systemName}...`,
            cancellable: false
        }, async (progress) => {
            if (systemFile) {
                await this.client.rex(`(ASDF:LOAD-ASD (UIOP:PARSE-NATIVE-NAMESTRING ${util.to_lisp_string(systemFile)}))`,
                    'COMMON-LISP-USER', 'T');
            }
            const res = await this.client.rex(`(ASDF:LOAD-SYSTEM ${util.to_lisp_string(systemName)})`,
                'COMMON-LISP-USER', 'T');
            const success = res.type === 'symbol' && res.source.toLowerCase() === 't';
            if (success) vscode.window.showInformationMessage(`Loaded system ${systemName}`)
            else vscode.window.showInformationMessage(`Failed to load system ${systemName}`)
        })
    }

    public async indentLine() {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const doc = editor.document;
            const lineIdx = editor.selection.active.line;
            const line = doc.lineAt(lineIdx);
            if (line.isEmptyOrWhitespace) return;
            const pkg = searchBufferPackage(doc, new vscode.Position(lineIdx, 0));
            const text = doc.getText(), ast = paredit.parse(text);
            const offset = doc.offsetAt(new vscode.Position(lineIdx, line.firstNonWhitespaceCharacterIndex));
            const desired = indent.getExpectedIndent(text, offset, pkg, this.systemSpecs, ast);
            const actual = line.text.match(/^\s*/)?.[0].length || 0;
            if (actual !== desired) {
                const workspaceEdit = new vscode.WorkspaceEdit();
                workspaceEdit.set(doc.uri, [vscode.TextEdit.replace(new vscode.Range(lineIdx, 0, lineIdx, actual), ' '.repeat(desired))]);
                await vscode.workspace.applyEdit(workspaceEdit);
            }
        }
    }

    public async newlineAndIndent() {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const doc = editor.document, pos = editor.selection.active;
            const text = doc.getText();
            const pkg = searchBufferPackage(doc, pos);
            const indentVal = indent.getExpectedIndent(text, doc.offsetAt(pos), pkg, this.systemSpecs);
            await editor.edit(editBuilder => {
                editBuilder.replace(editor.selection, '\n' + ' '.repeat(indentVal));
            });
        }
    }

    provideDocumentFormattingEdits(doc: vscode.TextDocument) {
        return this.provideDocumentRangeFormattingEdits(doc, new vscode.Range(0, 0, doc.lineCount - 1, 0));
    }

    provideDocumentRangeFormattingEdits(doc: vscode.TextDocument, range: vscode.Range) {
        const text = doc.getText(), ast = paredit.parse(text), edits: vscode.TextEdit[] = [];
        for (let i = range.start.line; i <= range.end.line; i++) {
            const line = doc.lineAt(i);
            if (line.isEmptyOrWhitespace) continue;
            const offset = doc.offsetAt(new vscode.Position(i, line.firstNonWhitespaceCharacterIndex));
            const pkg = searchBufferPackage(doc, range.start);
            const desired = indent.getExpectedIndent(text, offset, pkg, this.systemSpecs, ast);
            const actual = line.text.match(/^\s*/)?.[0].length || 0;
            if (actual !== desired) edits.push(vscode.TextEdit.replace(new vscode.Range(i, 0, i, actual), ' '.repeat(desired)));
        }
        return edits;
    }

    async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position) {
        if (!this.clientReady) return;
        const symbol = getSymbol(doc, pos);
        if (!symbol) return;
        const pkg = searchBufferPackage(doc, pos);
        const cmd = `(SWANK:SIMPLE-COMPLETIONS ${util.to_lisp_string(symbol)} ${util.to_lisp_string(pkg)})`;
        const res = await this.client.rex(cmd, pkg, ':REPL-THREAD');
        return res.children.map(convertCompletionItem);
    }

    async provideHover(doc: vscode.TextDocument, pos: vscode.Position) {
        if (!this.clientReady) return;
        const symbol = getSymbol(doc, pos);
        if (!symbol) return;
        const pkg = searchBufferPackage(doc, pos);
        const cmd = `(CL:IGNORE-ERRORS (SWANK-BACKEND:DESCRIBE-SYMBOL-FOR-EMACS
(SWANK::PARSE-SYMBOL-OR-LOSE ${util.to_lisp_string(symbol)} SWANK::*BUFFER-PACKAGE*)))`;
        const res = convertDescribeSymbol(await this.client.rex(cmd, pkg, ':REPL-THREAD'));
        if (res) { return new vscode.Hover(res); }
    }

    async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position) {
        if (!this.clientReady) return;
        const symbol = getSymbol(doc, pos);
        if (!symbol) return;
        const pkg = searchBufferPackage(doc, pos);
        const cmd = `(SWANK:FIND-DEFINITIONS-FOR-EMACS ${util.to_lisp_string(symbol)})`
        const definitions = await this.client.rex(cmd, pkg, ':REPL-THREAD');
        if (definitions.type === 'list') {
            const results = await Promise.all(definitions.children.map(convertDefinition));
            return results.filter(Boolean);
        }
    }
}
