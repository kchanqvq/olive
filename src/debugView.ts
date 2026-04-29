import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { plistGet, convertLocation, getExpression, OliveTextProvider } from './subr';
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
                        const location = await convertLocation(res);
                        if (location) {
                            const doc = await vscode.workspace.openTextDocument(location.uri);
                            const editor = await vscode.window.showTextDocument(doc, {
                                viewColumn: vscode.ViewColumn.One,
                                preview: true,
                                preserveFocus: true
                            });

                            const range = getExpression(doc, location.range.start, 'next');
                            if (range) {
                                this.decorationType?.dispose();
                                this.decorationType = vscode.window.createTextEditorDecorationType({
                                    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
                                });
                                editor.setDecorations(this.decorationType, [range]);
                                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                            }
                        } else {
                            vscode.window.showErrorMessage('Source location not available.')
                        }
                    }
                    break;
                case 'restartFrame':
                    await this.client.rex(`(SWANK:RESTART-FRAME ${m.index})`, 'COMMON-LISP-USER', this.info.thread);
                    break;
                case 'disassemble':
                    await this.showDisassembly(m.index);
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

    async showDisassembly(index: number) {
        const res = await this.client.rex(`(SWANK:SLDB-DISASSEMBLE ${index})`, 'COMMON-LISP-USER', this.info.thread);
        const content = util.from_lisp_string(res);
        const title = `Disassembly Frame ${index} (Thread ${this.info.thread})`;
        const uri = OliveTextProvider.getInstance().set(content, title);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
    }
}
