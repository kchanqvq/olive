import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { plistGet, convertLocation, getExpression, OliveDocumentProvider } from './subr';
const { util } = require('swank-client');

export class DebugView {
    public panel: vscode.WebviewPanel;
    // Set to true by 'debug_return' event from swank-client.
    // Send abort onDidDispose only if isHandled is false
    public isHandled = false;
    private decorationType?: vscode.TextEditorDecorationType;

    constructor(
        private context: vscode.ExtensionContext,
        private info: any,
        private client: any
    ) {
        this.panel = vscode.window.createWebviewPanel('oliveDebug', `Debugger: Level ${info.level}`, vscode.ViewColumn.Three, {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'resources'),
                vscode.Uri.joinPath(this.context.extensionUri, 'out')
            ]
        });

        this.panel.onDidDispose(() => {
            this.decorationType?.dispose();
            if(!this.isHandled)
                this.client.debug_escape_all(this.info.thread);
        });

        this.panel.webview.onDidReceiveMessage(async m => {
            switch (m.command) {
                case 'ready':
                    this.panel.webview.postMessage({ command: 'setData', info: this.info });
                    break;
                case 'invokeRestart':
                    this.client.debug_invoke_restart(this.info.level, m.index, this.info.thread);
                    break;
                case 'invokeAbort':
                    this.client.rex("(SWANK:SLDB-ABORT)", "COMMON-LISP-USER", this.info.thread);
                    break;
                case 'invokeContinue':
                    this.client.debug_continue(this.info.thread);
                    break;
                case 'getFrameLocals':
                    {
                        const res = await this.client.rex(`(SWANK:FRAME-LOCALS-AND-CATCH-TAGS ${m.index})`, 'COMMON-LISP-USER', this.info.thread);
                        const locals = util.from_lisp_bool(res.children[0]) ? res.children[0].children : [];
                        const catchTags = util.from_lisp_bool(res.children[1]) ? res.children[1].children : [];
                        this.panel.webview.postMessage({
                            command: 'frameLocals',
                            index: m.index,
                            locals: locals.map((l: any) => ({
                                name: util.from_lisp_string(plistGet(l, ':name')),
                                value: util.from_lisp_string(plistGet(l, ':value'))
                            })),
                            catchTags: catchTags.map(util.from_lisp_string)
                        });
                    }
                    break;
                case 'goToSource':
                    {
                        const res = await this.client.rex(`(SWANK:FRAME-SOURCE-LOCATION ${m.index})`, 'COMMON-LISP-USER', this.info.thread);
                        const locationOrUri = await convertLocation(res);
                        const [uri, range] = (locationOrUri instanceof vscode.Location) ?
                            [locationOrUri.uri, locationOrUri.range] : [locationOrUri, undefined];
                        if (uri) {
                            const doc = await vscode.workspace.openTextDocument(uri);
                            const editor = await vscode.window.showTextDocument(doc, {
                                viewColumn: vscode.ViewColumn.One,
                                preview: true,
                                preserveFocus: true
                            });

                            const expressionRange = range && getExpression(doc, range.start, 'next');
                            if (expressionRange) {
                                this.decorationType?.dispose();
                                this.decorationType = vscode.window.createTextEditorDecorationType({
                                    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
                                });
                                editor.setDecorations(this.decorationType, [expressionRange]);
                                editor.revealRange(expressionRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                            }
                        } else {
                            vscode.window.showErrorMessage('Source location not available.')
                        }
                    }
                    break;
                case 'restartFrame':
                    await this.client.rex(`(SWANK:RESTART-FRAME ${m.index})`, 'COMMON-LISP-USER', this.info.thread);
                    break;
                case 'disassembleFrame':
                    await this.disassembleFrame(m.index);
                    break;
                case 'returnFromFrame':
                    await this.returnFromFrame(m.index);
                    break;
                case 'evalInFrame':
                    await this.evalInFrame(m.index);
                    break;
            }
        });

        const { webview } = this.panel;
        const resUri = (p: string, dir: string = 'resources') => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, dir, p));
        const html = fs.readFileSync(resUri('debug.html').fsPath, 'utf8')
            .replace('{{cssUri}}', resUri('debug.css', 'out').toString())
            .replace('{{jsUri}}', resUri('debug.js', 'out').toString())
            .replace(/{{cspSource}}/g, webview.cspSource);

        this.panel.webview.html = html;
    }

    public setup(info: any) {
        this.panel.title = `Debugger: Level ${info.level}`
        this.info = info;
        this.panel.webview.postMessage({ command: 'setData', info: this.info });
    }

    async disassembleFrame(index: number) {
        const res = await this.client.rex(`(SWANK:SLDB-DISASSEMBLE ${index})`, 'COMMON-LISP-USER', this.info.thread);
        const content = util.from_lisp_string(res);
        const title = `Disassembly: Frame ${index} (Thread ${this.info.thread})`;
        const uri = OliveDocumentProvider.getInstance().set(content, title);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
    }

    async returnFromFrame(index: number) {
        const form = await vscode.window.showInputBox({prompt: 'Return from frame'});
        const res = await this.client.rex(`(SWANK:SLDB-RETURN-FROM-FRAME ${index} ${util.to_lisp_string(form)})`, 'COMMON-LISP-USER', this.info.thread);
        vscode.window.showInformationMessage(`Return from frame: ${util.from_lisp_string(res)}`);
    }

    async evalInFrame(index: number) {
        const pkg = util.from_lisp_string(await this.client.rex(`(SWANK:FRAME-PACKAGE-NAME ${index})`, 'COMMON-LISP-USER', this.info.thread));
        const form = await vscode.window.showInputBox({ prompt: `Eval in frame (${pkg})` });
        const cmd = `(SWANK:EVAL-STRING-IN-FRAME ${util.to_lisp_string(form)} ${index} ${util.to_lisp_string(pkg)} 1 80)`
        const res = await this.client.rex(cmd, 'COMMON-LISP-USER', this.info.thread);
        vscode.window.showInformationMessage(util.from_lisp_string(res));
    }
}
