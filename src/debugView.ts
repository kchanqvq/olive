import * as vscode from 'vscode';
import * as fs from 'fs';

export class DebugView {
    public panel: vscode.WebviewPanel;
    // Set to true by 'debug_return' event from swank-client.
    // Send abort onDidDispose only if isHandled is false
    public isHandled = false;

    constructor(
        private context: vscode.ExtensionContext,
        private info: any,
        private client: any
    ) {
        this.panel = vscode.window.createWebviewPanel('oliveDebug', `Debugger: Level ${info.level}`, vscode.ViewColumn.Three, {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'resources')]
        });

        this.panel.onDidDispose(() => {
            if(!this.isHandled)
                this.client.debug_escape_all(this.info.thread);
        });

        this.panel.webview.onDidReceiveMessage(m => {
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
            }
        });

        const { webview } = this.panel;
        const resUri = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'resources', p));
        const html = fs.readFileSync(resUri('debug.html').fsPath, 'utf8')
            .replace('{{cssUri}}', resUri('debug.css').toString())
            .replace('{{jsUri}}', resUri('debug.js').toString())
            .replace(/{{cspSource}}/g, webview.cspSource);

        this.panel.webview.html = html;
    }

    public setup( info: any){
        this.panel.title = `Debugger: Level ${info.level}`
        this.info = info;
        this.panel.webview.postMessage({ command: 'setData', info: this.info });
    }
}
