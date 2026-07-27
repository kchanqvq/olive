import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ReplView } from './replView';
import { DebugView } from './debugView';
import { plistGet, severityOrder, convertCompilerNote, searchBufferPackage, getSymbol, getAst, getExpression, getTopLevelForm,
    convertCompletionItem, convertLocation, convertDescribeSymbol, convertIndentSpec, formatAutodocRawForm } from './subr';
import * as indent from './indent';
const { Client, util } = require('swank-client');

const evalResultDecorationType = vscode.window.createTextEditorDecorationType({
    after: {margin: '0 0 0 2em',
        color: new vscode.ThemeColor('editorCodeLens.foreground')},
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    isWholeLine: true
})

const evalFlashDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.selectionBackground')
})

export class LispSession implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider, vscode.CompletionItemProvider, vscode.HoverProvider, vscode.DefinitionProvider, vscode.ReferenceProvider, vscode.SignatureHelpProvider {
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
        private systemSpecs: Map<string, Map<string, indent.IndentSpec>>
    ) {
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
                editor.setDecorations(evalResultDecorationType, []);
            }
        }));

        ctx.subscriptions.push(
            vscode.commands.registerCommand('olive.connect', () => this.connect()),
            vscode.commands.registerCommand('olive.startLisp', () => this.startLisp()),
            vscode.commands.registerCommand('olive.disconnect', () => this.disconnect()),
            vscode.commands.registerCommand('olive.interrupt', () => this.interrupt()),
            vscode.commands.registerCommand('olive.evaluating', () => vscode.commands.executeCommand('olive.interrupt')),
            vscode.commands.registerTextEditorCommand('olive.syncRepl', (editor, edit) => this.syncRepl(editor, edit)),
            vscode.commands.registerTextEditorCommand('olive.compileFile', (editor, edit) => this.compileFile(editor, edit)),
            vscode.commands.registerTextEditorCommand('olive.compileFileDebug', (editor, edit) => this.compileFile(editor, edit, "'((CL:DEBUG . 3))")),
            vscode.commands.registerTextEditorCommand('olive.loadFile', (editor, edit) => this.loadFile(editor, edit)),
            vscode.commands.registerTextEditorCommand('olive.compileDefun', (editor, edit) => this.compileDefun(editor, edit)),
            vscode.commands.registerTextEditorCommand('olive.compileDefunDebug', (editor, edit) => this.compileDefun(editor, edit, "'((CL:DEBUG . 3))")),
            vscode.commands.registerTextEditorCommand('olive.evalLastExpression', (editor, edit) => this.evalLastExpression(editor, edit)),
            vscode.commands.registerTextEditorCommand('olive.evalDefun', (editor, edit) => this.evalDefun(editor, edit)),
            vscode.commands.registerCommand('olive.loadWorkspaceSystem', () => this.loadWorkspaceSystem()),
            vscode.commands.registerTextEditorCommand('olive.indentLine', (editor, edit) => this.indentLine(editor, edit)),
            vscode.commands.registerTextEditorCommand('olive.newlineAndIndent', (editor, edit) => this.newlineAndIndent(editor, edit)));
    }

    public checkClient() {
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
            this.lispProcess.on('error', (err) => {
                this.lispOutputChannel?.appendLine(`\n${err}`);
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
                if (!this.lispProcess)
                    throw new Error('Did you install Lisp and configure olive.lispCommand?');
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

                // VSCode focus management does not return focus when
                // a (debugger) tab is closed, so we have to maintain
                // it (simulate Emacs quit-window) ourselves.

                // Having to manage focus ourselves is cancerous, the
                // hardcoded commands are double cancerous.
                const replFocus = this.replProvider.focus;
                const column = vscode.window.activeTextEditor?.viewColumn || 1;
                const cmd = replFocus ? 'olive.replView.focus' : ['', 'workbench.action.focusFirstEditorGroup', 'workbench.action.focusSecondEditorGroup', 'workbench.action.focusThirdEditorGroup', 'workbench.action.focusFourthEditorGroup', 'workbench.action.focusFifthEditorGroup', 'workbench.action.focusSixthEditorGroup', 'workbench.action.focusSeventhEditorGroup', 'workbench.action.focusNinthEditorGroup', 'workbench.action.focusLastEditorGroup'] [column];
                const quitHook = () => vscode.commands.executeCommand(cmd);
                if (view) {
                    view.setup(info, quitHook);
                }
                else {
                    this.debugViews.set(info.thread, new DebugView(this.ctx, info, this.client, quitHook));
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
                this.replProvider.sendSystemSpecs();
            });

            const events = ['presentation_start', 'presentation_end', 'debug_activate', 'read_from_minibuffer', 'y_or_n_p', 'read_aborted', 'profile_command_complete'];
            events.forEach(e => this.client.on(e, (...args: any[]) => console.log(`Swank event: ${e}`, ...args)));

            
            const info = await this.client.initialize();
            await this.client.rex("(SWANK:SWANK-REQUIRE '(SWANK-IO-PACKAGE::SWANK-MACROSTEP SWANK-IO-PACKAGE::SWANK-INDENTATION))",
                'COMMON-LISP-USER', 'T');
            // SWANK's initial indentation scan races with loading
            // SWANK-INDENTATION above, and it only rescans when a new package
            // appears, so we can be stuck with swank.lisp's cruder specs. Force
            // rescan.
            await this.client.rex('(SWANK:UPDATE-INDENTATION-INFORMATION)', 'COMMON-LISP-USER', 'T');

            this.clientReady = true;
            this.statusConnected();
            this.replProvider.setClient(this.client, info);
            await vscode.commands.executeCommand('olive.replView.open', { preserveFocus: true })
        } catch (err) {
            this.statusDisconnected();
            vscode.window.showErrorMessage(`Failed to connect: ${err}`);
        }
    }

    private statusDisconnected() {
        this.statusBarItem.text = "$(debug-disconnect) OLIVE: Disconnected";
        this.statusBarItem.tooltip = "Start lisp process"
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }

    private statusConnecting() {
        this.statusBarItem.text = "$(sync~spin) OLIVE: Connecting...";
        this.statusBarItem.tooltip = "Restart lisp process"
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    private statusConnected() {
        this.statusBarItem.text = "$(check) OLIVE: Connected";
        this.statusBarItem.tooltip = "Restart lisp process"
        this.statusBarItem.backgroundColor = undefined;
    }

    public dispose() {
        this.client?.disconnect();
        this.lispProcess?.kill();
    }

    private reportCompilationResult(
        doc: vscode.TextDocument, res: any, defaultPos = new vscode.Position(0,0)
    ) {
        if (res.type === 'list') {
            const success = util.from_lisp_bool(res.children[2]);
            const duration = Number(res.children[3].source);

            let msg = success ? "Compilation finished" : "Compilation failed";
            if (util.from_lisp_bool(res.children[1])) {
                const notes = res.children[1].children;
                const noteCounts: Map<string, number> = new Map(severityOrder.map(s => [s, 0]));
                for (const note of notes) {
                    let severity = plistGet(note, ':severity').source.slice(1).toLowerCase();
                    noteCounts.set(severity, (noteCounts.get(severity) || 0) + 1);
                }

                msg += ": ";
                for (const [severity, count] of noteCounts) {
                    if (count > 0) {
                        msg += `${count} ${severity}${count > 1 ? 's' : ''}  `;
                    }
                }

                this.diagnostics.set(doc.uri,
                    notes.map((n: any) => convertCompilerNote(doc, n, defaultPos)));

            } else {
                msg += ". (No warnings)  ";
                this.diagnostics.set(doc.uri, []);
            }

            msg += `[${duration.toFixed(2)} secs]`;

            (success ? vscode.window.showInformationMessage : vscode.window.showErrorMessage)(msg);
        } else {
            vscode.window.showErrorMessage(`Compilation failed: ${util.from_lisp_string(res)}`);
        }
    }

    public async compileFile(editor: vscode.TextEditor, edit: vscode.TextEditorEdit, policy: string = 'NIL') {
        if (!this.checkClient()) return;

        const doc = editor.document;
        if (doc.isDirty) await doc.save();

        const fileName = doc.fileName;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Compiling ${path.basename(fileName)}...`,
            cancellable: false
        }, async (progress) => {
            const cmd = `(SWANK:COMPILE-FILE-FOR-EMACS
(UIOP:PARSE-NATIVE-NAMESTRING ${util.to_lisp_string(fileName)}) T :POLICY ${policy})`;
            const res = await this.client.rex(cmd, 'COMMON-LISP-USER', 'T');
            this.reportCompilationResult(doc, res);

            if (res.type === 'list') {
                const success = util.from_lisp_bool(res.children[2]);
                const faslfile = util.from_lisp_bool(res.children[5]) && util.from_lisp_string(res.children[5]);

                if (faslfile &&
                    (success ||
                        await vscode.window.showInformationMessage('Compilation failed. Load fasl file anyway?',
                            { modal: true }, 'Load') === 'Load'))
                    this.client.rex(`(SWANK:LOAD-FILE ${util.to_lisp_string(faslfile)})`, 'COMMON-LISP-USER', 'T');
            }
        });
    }

    public async loadFile(editor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
        if (!this.checkClient()) return;

        const doc = editor.document;
        if (doc.isDirty) await doc.save();

        const fileName = doc.fileName;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Loading ${path.basename(fileName)}...`,
            cancellable: false
        }, async (progress) => {
            const cmd = `(SWANK:LOAD-FILE
(UIOP:PARSE-NATIVE-NAMESTRING ${util.to_lisp_string(fileName)}))`;
            await this.client.rex(cmd, 'COMMON-LISP-USER', 'T');
            vscode.window.showInformationMessage('Load finished.');
        })
    }

    async compileRegion(doc: vscode.TextDocument, range: vscode.Range, policy: string = 'NIL') {
        const fileName = doc.fileName;
        const title = path.basename(fileName);
        const pkg = searchBufferPackage(doc, range.start);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Compiling region in ${title}...`,
            cancellable: false
        }, async (progress) => {
            const text = doc.getText(range);
            const pos = `'((:POSITION ${doc.offsetAt(range.start) + 1}) (:LINE ${range.start.line + 1} ${range.start.character + 1}))`
            // There might be some namestring vs native-namestring
            // quriks here.  I want to use UIOP:PARSE-NATIVE-NAMESTRING,
            // but SBCL want only string, not pathnames.
            const cmd = `(SWANK:COMPILE-STRING-FOR-EMACS
${util.to_lisp_string(text)} ${util.to_lisp_string(doc.uri.toString())} ${pos}
${doc.isUntitled ? 'NIL' : util.to_lisp_string(doc.fileName)} ${policy})`;
            const res = await this.client.rex(cmd, pkg, 'T');
            this.reportCompilationResult(doc, res, range.start);
        });
    }

    private flashRegion(editor: vscode.TextEditor, range?: vscode.Range) {
        const duration = vscode.workspace.getConfiguration('olive').get('evalFlashDuration', 200);
        if (duration > 0 && range) {
            editor.setDecorations(evalFlashDecorationType, [range]);
            setTimeout(() => editor.setDecorations(evalFlashDecorationType, []), duration);
        }
    }

    public async compileDefun(editor: vscode.TextEditor, edit: vscode.TextEditorEdit, policy: string = 'NIL') {
        if (!this.checkClient()) return;

        const doc = editor.document, pos = editor.selection.active;
        const range = getTopLevelForm(doc, pos);
        this.flashRegion(editor, range);
        if (range) await this.compileRegion(doc, range, policy);
        else vscode.window.showErrorMessage('No top level form at or before the selection.')
    }

    public async evalRegion(editor: vscode.TextEditor, range: vscode.Range) {
        const doc = editor.document;
        const pkg = searchBufferPackage(doc, range.start);
        const code = doc.getText(range);

        editor.setDecorations(evalResultDecorationType, []);
        const res = await this.client.rex(`(SWANK:INTERACTIVE-EVAL ${util.to_lisp_string(code)} 1 40)`, pkg, 'T');
        const resultStr = util.from_lisp_string(res);
        const lineEnd = doc.lineAt(range.end.line).range.end;

        editor.setDecorations(evalResultDecorationType, [{
            range: new vscode.Range(lineEnd, lineEnd),
            renderOptions: { after: { contentText: '; ' + resultStr } }
        }]);

    }

    public async evalLastExpression(editor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
        if (!this.checkClient()) return;

        const doc = editor.document, pos = editor.selection.active;
        const range = getExpression(doc, pos, 'prev');
        this.flashRegion(editor, range);
        if (range) await this.evalRegion(editor, range);
        else vscode.window.showErrorMessage('No expression at or before the selection.')
    }

    public async evalDefun(editor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
        if (!this.checkClient()) return;

        const doc = editor.document, pos = editor.selection.active;
        const range = getTopLevelForm(doc, pos);
        this.flashRegion(editor, range);
        if (range) await this.evalRegion(editor, range);
        else vscode.window.showErrorMessage('No expression at or before the selection.')
    }

    public async loadWorkspaceSystem() {
        if (!this.checkClient()) return;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('Cannot find workspace root directory.');
            return;
        }

        const asdFiles = await vscode.workspace.findFiles('*.asd');
        if (asdFiles.length === 0) {
            vscode.window.showErrorMessage('No .asd file found in workspace root directory.')
            return;
        }

        // Some heurstics to guess ASD system/file
        const workspaceFolderName = path.basename(workspaceRoot);
        const winner = asdFiles.find(f => path.basename(f.fsPath, '.asd') === workspaceFolderName)
            || asdFiles.sort((a, b) => a.fsPath.localeCompare(b.fsPath)).at(-1)!;

        await this.loadSystem(path.basename(winner.fsPath, '.asd'), winner.fsPath);
    }

    public async syncRepl(editor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
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

    public indentLine(editor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
        const doc = editor.document;
        const lineIdx = editor.selection.active.line;
        const line = doc.lineAt(lineIdx);
        if (line.isEmptyOrWhitespace) return;
        const pkg = searchBufferPackage(doc, new vscode.Position(lineIdx, 0));
        const text = doc.getText(), ast = getAst(doc);
        const offset = doc.offsetAt(new vscode.Position(lineIdx, line.firstNonWhitespaceCharacterIndex));
        const desired = indent.getExpectedIndent(text, offset, pkg, this.systemSpecs, ast);
        const actual = line.firstNonWhitespaceCharacterIndex;
        if (actual !== desired) {
            edit.replace(new vscode.Range(lineIdx, 0, lineIdx, actual), ' '.repeat(desired));
        }
    }

    public newlineAndIndent(editor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
        const doc = editor.document, pos = editor.selection.active;
        const text = doc.getText();
        const pkg = searchBufferPackage(doc, pos);
        const indentVal = indent.getExpectedIndent(text, doc.offsetAt(pos), pkg, this.systemSpecs, getAst(doc));
        edit.replace(editor.selection, '\n' + ' '.repeat(indentVal));
    }

    provideDocumentFormattingEdits(doc: vscode.TextDocument) {
        return this.provideDocumentRangeFormattingEdits(doc, new vscode.Range(0, 0, doc.lineCount - 1, 0));
    }

    provideDocumentRangeFormattingEdits(doc: vscode.TextDocument, range: vscode.Range) {
        const text = doc.getText(), ast = getAst(doc), edits: vscode.TextEdit[] = [];
        const pkg = searchBufferPackage(doc, range.start);
        for (let i = range.start.line; i <= range.end.line; i++) {
            const line = doc.lineAt(i);
            if (line.isEmptyOrWhitespace) continue;
            const offset = doc.offsetAt(new vscode.Position(i, line.firstNonWhitespaceCharacterIndex));
            const desired = indent.getExpectedIndent(text, offset, pkg, this.systemSpecs, ast);
            const actual = line.firstNonWhitespaceCharacterIndex;
            if (actual !== desired) edits.push(vscode.TextEdit.replace(new vscode.Range(i, 0, i, actual), ' '.repeat(desired)));
        }
        return edits;
    }

    async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position) {
        if (!this.clientReady) return;
        const symbol = getSymbol(doc, pos);
        if (!symbol) return;
        const pkg = searchBufferPackage(doc, pos);
        const style = vscode.workspace.getConfiguration('olive').get('completionStyle');
        const cmd = (style === 'fuzzy') ?
            `(SWANK:FUZZY-COMPLETIONS ${util.to_lisp_string(symbol)} ${util.to_lisp_string(pkg)})` :
            `(SWANK:SIMPLE-COMPLETIONS ${util.to_lisp_string(symbol)} ${util.to_lisp_string(pkg)})`;
        const res = await this.client.rex(cmd, pkg, 'T');
        const completions = (style === 'fuzzy') ? res.children[0] : res;
        // Pass isComplete = true to force VSCode to always query
        // SLIME. This is because both SLIME and VS Code try to be
        // smart and result in glitch. In particular, SLIME try to
        // guess symbol case, and the case of returned completions can
        // change when more input is typed; VS Code cache these
        // completions which may become stale.
        return new vscode.CompletionList(completions.children.map(convertCompletionItem), true);
    }

    async provideHover(doc: vscode.TextDocument, pos: vscode.Position) {
        if (!this.clientReady) return;
        const symbol = getSymbol(doc, pos);
        if (!symbol) return;
        const pkg = searchBufferPackage(doc, pos);
        const cmd = `(CL:IGNORE-ERRORS (SWANK-BACKEND:DESCRIBE-SYMBOL-FOR-EMACS
(SWANK::PARSE-SYMBOL-OR-LOSE ${util.to_lisp_string(symbol)} SWANK::*BUFFER-PACKAGE*)))`;
        const res = convertDescribeSymbol(await this.client.rex(cmd, pkg, 'T'));
        if (res) { return new vscode.Hover(res); }
    }

    async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position) {
        if (!this.clientReady) return;

        const symbol = getSymbol(doc, pos);
        if (!symbol) return;
        const pkg = searchBufferPackage(doc, pos);
        const cmd = `(SWANK:FIND-DEFINITIONS-FOR-EMACS ${util.to_lisp_string(symbol)})`
        const definitions = await this.client.rex(cmd, pkg, 'T');
        if (definitions.type === 'list') {
            const results = await Promise.all(definitions.children.map(
                async (def: any) => {
                    const locationOrUri = await convertLocation(def.children[1]);
                    return (locationOrUri instanceof vscode.Uri) ?
                        new vscode.Location(locationOrUri, new vscode.Position(0, 0)) :
                        locationOrUri;
                }));
            return results.filter(Boolean);
        }
    }

    async provideReferences(doc: vscode.TextDocument, pos: vscode.Position) {
        if (!this.clientReady) return;

        const symbol = getSymbol(doc, pos);
        if (!symbol) return;
        const pkg = searchBufferPackage(doc, pos);
        const cmd = `(SWANK:XREFS '(:CALLS :MACROEXPANDS :BINDS :REFERENCES :SETS :SPECIALIZES)
${util.to_lisp_string(symbol)})`
        const references = await this.client.rex(cmd, pkg, 'T');
        if (references.type === 'list') {
            const results: vscode.Location[] = [];
            for (const category of references.children) {
                if (category.type === 'list' && category.children.length > 1) {
                    for (const item of category.children.slice(1)) {
                        const locationOrUri = await convertLocation(item.children[1]);
                        if (locationOrUri) {
                            results.push((locationOrUri instanceof vscode.Uri) ?
                                new vscode.Location(locationOrUri, new vscode.Position(0, 0)) :
                                locationOrUri);
                        }
                    }
                }
            }
            return results;
        }
    }

    async provideSignatureHelp(doc: vscode.TextDocument, pos: vscode.Position) {
        if (!this.clientReady) return;

        const pkg = searchBufferPackage(doc, pos);
        const text = doc.getText(), offset = doc.offsetAt(pos), ast = getAst(doc);
        const topLevelNode = ast.children.find((child: any) => offset >= child.start && offset <= child.end);

        const rawForm = formatAutodocRawForm(text, offset, topLevelNode);
        if (!rawForm) return;
        const cmd = `(SWANK:AUTODOC '${rawForm})`;
        const res = await this.client.rex(cmd, pkg, 'T');
        
        if (res.type !== 'list') return;

        const autodoc = util.from_lisp_string(res.children[0]);
        if (autodoc === ':not-available' || autodoc === "") return;

        const sigHelp = new vscode.SignatureHelp();
        const sigInfo = new vscode.SignatureInformation(autodoc.replace('===> ', '').replace(' <===', ''));
        sigHelp.signatures = [sigInfo];
        sigHelp.activeSignature = 0;

        const start = autodoc.indexOf('===> ');
        const end = autodoc.indexOf(' <===');
        if (start >= 0 && end >= 0) {
            sigInfo.parameters = [new vscode.ParameterInformation([start, end - 5])];
            sigInfo.activeParameter = 0;
        }

        return sigHelp;
    }
}
