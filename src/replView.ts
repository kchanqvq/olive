import * as vscode from 'vscode';
import * as fs from 'fs';
import * as indent from './indent';
const { util } = require('swank-client');

export class ReplView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'olive.replView';
    private view?: vscode.WebviewView;
    private readResolver?: (text: string) => void;
    private client: any;
    private readyResolve?: () => void;
    private readyPromise: Promise<void>;
    public currentPackage = 'COMMON-LISP-USER';
    public currentNickname = 'CL-USER';

    constructor(private context: vscode.ExtensionContext,
        private systemSpecs: Map<string, Map<string, indent.IndentSpec>>) {
        this.readyPromise = new Promise(resolve => this.readyResolve = resolve);
    }

    public setClient(client: any, info: any) {
        this.client = client;
        if (client){
            this.currentPackage = util.from_lisp_string(info.children[0]);
            this.currentNickname = util.from_lisp_string(info.children[1]);

            this.setupClientListeners();

            const encouragements = [
                "Let the hacking commence!",
                "Hacks and glory await!",
                "Hack and be merry!",
                "Your hacking starts... NOW!",
                "May the source be with you!",
                "Lemonodor-fame is but a hack away!",
                "Are we consing yet?",
                "This could be the start of a beautiful program."
            ];
            const encouragement = encouragements[Math.floor(Math.random() * encouragements.length)];

            this.post('addOutput', { text: `; Connected. ${encouragement}\n`, type: 'status' });
            this.post('prompt', { package: this.currentNickname });
        } else {
            vscode.commands.executeCommand('setContext', 'olive.isEvaluating', false);
            this.post('disconnect');
            this.post('addOutput', { text: '; Disconnected\n', type: 'status' });
        }
    }

    public async setPackage(pkg?: string) {
        if (!pkg) {
            const pkglist = await this.client.rex(`(SWANK:LIST-ALL-PACKAGE-NAMES)`, 'COMMON-LISP-USER', ':REPL-THREAD');
            pkg = await vscode.window.showQuickPick(pkglist.children.map(util.from_lisp_string));
            if (!pkg) return;
        }
        const res = await this.client.rex(`(SWANK:SET-PACKAGE ${util.to_lisp_string(pkg)})`, 'COMMON-LISP-USER', ':REPL-THREAD');
        if (res.type === 'list') {
            this.currentPackage = util.from_lisp_string(res.children[0]);
            this.currentNickname = util.from_lisp_string(res.children[1]);
            this.post('setPrompt', { package: this.currentNickname });
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken) {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        };

        const { webview } = webviewView;
        const resUri = (p: string, dir: string = 'resources') =>
            webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, dir, p));

        webviewView.webview.html = fs.readFileSync(resUri('repl.html').fsPath, 'utf8')
            .replace('{{cssUri}}', resUri('repl.css').toString())
            .replace('{{jsUri}}', resUri('repl.js', 'out').toString())
            .replace(/{{cspSource}}/g, webview.cspSource);

        webviewView.webview.onDidReceiveMessage((m) => {
            switch (m.command) {
                case 'eval':         this.evaluate(m.text); break;
                case 'readSubmit':   this.readResolver?.(m.text + '\n'); break;
                case 'autocomplete': this.autocomplete(m.text, m.requestId); break;
                case 'interrupt':    this.client?.interrupt(); break;
                case 'unthrottle':   this.client?.socket.resume(); break;
                case 'ready':        
                    this.sendSettings(); 
                    this.sendSpecs();
                    this.readyResolve?.();
                    break;
            }
        });
    }

    public sendSpecs() {
        const specs = Array.from(this.systemSpecs.entries()).map(([pkg, specMap]) => [
            pkg, Array.from(specMap.entries())
        ]);
        this.post('syncSpecs', { specs });
    }

    private setupClientListeners() {
        this.client.on('print_string', (s: string, t: string) => {
            this.client.socket.pause();
            this.post('addOutput', { text: s, type: t, throttle: t });
        });
        this.client.on('new_package', (p: string, n: string) => {
            this.currentPackage = p;
            this.currentNickname = n;
            this.post('setPrompt', { package: this.currentNickname });
        });
        this.client.on('read_string', () => {
            this.post('read');
            return new Promise<string>(r => this.readResolver = r);
        });
    }

    public sendSettings() {
        const config = vscode.workspace.getConfiguration('editor');
        this.post('settings', {
            minWordLength: config.get<number>('suggest.minWordLength') ?? 3,
            delay: config.get<number>('quickSuggestionsDelay') ?? 10
        });
    }

    private async evaluate(text: string) {
        if (!this.client) return;
        
        vscode.commands.executeCommand('setContext', 'olive.isEvaluating', true);
        try {
            const result = await this.client.eval(text, this.currentPackage);
            // Current swank-client doesn't report status,
            // we assume getting a string result means :abort
            if (util.from_lisp_bool(result))
                this.post('addOutput', { text: `; Evaluation aborted on ${util.from_lisp_string(result)}.` ,
                    type: 'status'});
        } finally {
            vscode.commands.executeCommand('setContext', 'olive.isEvaluating', false);
        }
        this.post('prompt', { package: this.currentNickname });
    }

    private async autocomplete(text: string, requestId: string) {
        if (!this.client) return;
        try {
            const cmd = `(SWANK:SIMPLE-COMPLETIONS ${util.to_lisp_string(text)} ${util.to_lisp_string(this.currentPackage)})`;
            const res = await this.client.rex(cmd, this.currentPackage, ':REPL-THREAD');
            const completions = res.children.map((c: any) => util.from_lisp_string(c.children[0]));
            this.post('autocompleteResults', { completions, requestId });
        } catch {
            this.post('autocompleteResults', { completions: [], requestId });
        }
    }

    public clear() {
        this.post('flush');
        this.post('addOutput', {text: '; output flushed\n', type: 'status'});
    }

    private async post(command: string, data: any = {}) {
        await this.readyPromise;
        this.view?.webview.postMessage({ command, ...data });
    }
}
