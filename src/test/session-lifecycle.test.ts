import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LispSession } from '../session';
import { ReplView } from '../replView';

const { Client } = require('swank-client');
const { util } = require('swank-client');

describe('Lisp session connection lifecycle', () => {
    const originalConnect = Client.prototype.connect;
    const originalDisconnect = Client.prototype.disconnect;
    const originalInitialize = Client.prototype.initialize;
    const originalRex = Client.prototype.rex;

    before(() => {
        Client.prototype.connect = async function() {
            this.connected = true;
        };
        Client.prototype.disconnect = function() {
            this.connected = false;
        };
        Client.prototype.initialize = async function() {
            return {};
        };
        Client.prototype.rex = async function() {
            return { type: 'symbol', source: 'T' };
        };
    });

    after(() => {
        Client.prototype.connect = originalConnect;
        Client.prototype.disconnect = originalDisconnect;
        Client.prototype.initialize = originalInitialize;
        Client.prototype.rex = originalRex;
    });

    it('ignores a delayed disconnect from a superseded client', async () => {
        const subscriptions: vscode.Disposable[] = [];
        let replClient: any;
        const replProvider = {
            focus: false,
            setClient(client: any) {
                replClient = client;
            },
            sendSystemSpecs() {}
        } as unknown as ReplView;
        const context = {
            extensionPath: '',
            subscriptions
        } as unknown as vscode.ExtensionContext;
        const session = new LispSession(context, replProvider, new Map());
        subscriptions.push(vscode.commands.registerCommand('olive.replView.open', () => {}));

        try {
            await session.connectTo('localhost', 4005);
            const oldClient = session.client;
            assert.ok(session.clientReady);

            session.disconnect();
            assert.strictEqual(session.client, undefined);
            assert.strictEqual(replClient, undefined);

            await session.connectTo('localhost', 4005);
            const currentClient = session.client;
            assert.ok(session.clientReady);

            oldClient.on_handlers.disconnect();

            assert.strictEqual(session.client, currentClient);
            assert.strictEqual(session.clientReady, true);
            assert.strictEqual(replClient, currentClient);
            assert.match(
                Object.getOwnPropertyDescriptor(session, 'statusBarItem')?.value.text,
                /Connected/
            );
        } finally {
            session.disconnect();
            for (const subscription of subscriptions.reverse()) {
                subscription.dispose();
            }
        }
    });
});

describe('Compile and load error reporting', () => {
    it('reports rejected compile-region and system-load requests', async () => {
        const originalShowErrorMessage = vscode.window.showErrorMessage;
        const errors: string[] = [];
        vscode.window.showErrorMessage = ((message: string) => {
            errors.push(message);
            return Promise.resolve(undefined);
        }) as typeof vscode.window.showErrorMessage;

        const subscriptions: vscode.Disposable[] = [];
        const replProvider = {
            focus: false,
            setClient() {},
            sendSystemSpecs() {}
        } as unknown as ReplView;
        const context = {
            extensionPath: '',
            subscriptions
        } as unknown as vscode.ExtensionContext;
        const session = new LispSession(context, replProvider, new Map());
        const client = {
            async rex() {
                throw new Error('RPC unavailable');
            },
            disconnect() {}
        };
        session.client = client;
        session.clientReady = true;

        const doc = {
            fileName: 'test.lisp',
            uri: vscode.Uri.file('test.lisp'),
            isUntitled: false,
            isDirty: false,
            lineCount: 1,
            lineAt: () => ({ text: '(+ 10 20)' }),
            getText: () => '(+ 10 20)',
            offsetAt: () => 0
        } as unknown as vscode.TextDocument;
        const editor = { document: doc } as vscode.TextEditor;
        const edit = {} as vscode.TextEditorEdit;

        try {
            await session.compileFile(editor, edit);
            await session.loadFile(editor, edit);
            await session.compileRegion(doc, new vscode.Range(0, 0, 0, 9));
            await session.loadSystem('broken-system');

            assert.deepStrictEqual(errors, [
                'Failed to compile test.lisp: RPC unavailable',
                'Loading test.lisp failed: RPC unavailable',
                'Failed to compile region in test.lisp: RPC unavailable',
                'Failed to load system broken-system: RPC unavailable'
            ]);
        } finally {
            vscode.window.showErrorMessage = originalShowErrorMessage;
            session.dispose();
            for (const subscription of subscriptions.reverse()) {
                subscription.dispose();
            }
        }
    });

    it('reports an unsuccessful compiler result without claiming success', async () => {
        const originalShowErrorMessage = vscode.window.showErrorMessage;
        const originalShowInformationMessage = vscode.window.showInformationMessage;
        const errors: string[] = [];
        const information: string[] = [];
        vscode.window.showErrorMessage = ((message: string) => {
            errors.push(message);
            return Promise.resolve(undefined);
        }) as typeof vscode.window.showErrorMessage;
        vscode.window.showInformationMessage = ((message: string) => {
            information.push(message);
            return Promise.resolve(undefined);
        }) as typeof vscode.window.showInformationMessage;

        const subscriptions: vscode.Disposable[] = [];
        const replProvider = {
            focus: false,
            setClient() {},
            sendSystemSpecs() {}
        } as unknown as ReplView;
        const context = {
            extensionPath: '',
            subscriptions
        } as unknown as vscode.ExtensionContext;
        const session = new LispSession(context, replProvider, new Map());
        session.client = {
            async rex() {
                return {
                    type: 'list',
                    children: [
                        { type: 'symbol', source: 'NIL' },
                        { type: 'symbol', source: 'NIL' },
                        { type: 'symbol', source: 'NIL' },
                        { type: 'number', source: '0.01' },
                        { type: 'symbol', source: 'NIL' },
                        { type: 'symbol', source: 'NIL' }
                    ]
                };
            },
            disconnect() {}
        };
        session.clientReady = true;
        const doc = {
            fileName: 'test.lisp',
            isDirty: false
        } as vscode.TextDocument;
        const editor = { document: doc } as vscode.TextEditor;

        try {
            await session.compileFile(editor, {} as vscode.TextEditorEdit);
            assert.deepStrictEqual(errors, [
                'Compilation failed. (No warnings)  [0.01 secs]'
            ]);
            assert.deepStrictEqual(information, []);
        } finally {
            vscode.window.showErrorMessage = originalShowErrorMessage;
            vscode.window.showInformationMessage = originalShowInformationMessage;
            session.dispose();
            for (const subscription of subscriptions.reverse()) {
                subscription.dispose();
            }
        }
    });

    it('reports a non-true load result instead of claiming success', async () => {
        const originalShowErrorMessage = vscode.window.showErrorMessage;
        const originalShowInformationMessage = vscode.window.showInformationMessage;
        const errors: string[] = [];
        const information: string[] = [];
        vscode.window.showErrorMessage = ((message: string) => {
            errors.push(message);
            return Promise.resolve(undefined);
        }) as typeof vscode.window.showErrorMessage;
        vscode.window.showInformationMessage = ((message: string) => {
            information.push(message);
            return Promise.resolve(undefined);
        }) as typeof vscode.window.showInformationMessage;

        const subscriptions: vscode.Disposable[] = [];
        const replProvider = {
            focus: false,
            setClient() {},
            sendSystemSpecs() {}
        } as unknown as ReplView;
        const context = {
            extensionPath: '',
            subscriptions
        } as unknown as vscode.ExtensionContext;
        const session = new LispSession(context, replProvider, new Map());
        session.client = {
            async rex() {
                return { type: 'string', source: '"NIL"' };
            },
            disconnect() {}
        };
        session.clientReady = true;
        const doc = {
            fileName: 'test.lisp',
            isDirty: false
        } as vscode.TextDocument;
        const editor = { document: doc } as vscode.TextEditor;

        try {
            await session.loadFile(editor, {} as vscode.TextEditorEdit);
            assert.deepStrictEqual(errors, ['Loading test.lisp failed: NIL']);
            assert.deepStrictEqual(information, []);
        } finally {
            vscode.window.showErrorMessage = originalShowErrorMessage;
            vscode.window.showInformationMessage = originalShowInformationMessage;
            session.dispose();
            for (const subscription of subscriptions.reverse()) {
                subscription.dispose();
            }
        }
    });
});

describe('Lisp shutdown', () => {
    it('does not wait indefinitely for the Swank quit RPC', async () => {
        const subscriptions: vscode.Disposable[] = [];
        let replClient: any;
        const replProvider = {
            focus: false,
            setClient(client: any) {
                replClient = client;
            },
            sendSystemSpecs() {}
        } as unknown as ReplView;
        const context = {
            extensionPath: '',
            subscriptions
        } as unknown as vscode.ExtensionContext;
        const session = new LispSession(context, replProvider, new Map());
        let quitRequests = 0;
        const client = {
            rex() {
                quitRequests++;
                return new Promise<never>(() => {});
            },
            disconnect() {}
        };
        const child = new EventEmitter() as EventEmitter & {
            exitCode: number | null;
            signalCode: NodeJS.Signals | null;
            stdin: { end(): void };
            kill(): boolean;
        };
        child.exitCode = null;
        child.signalCode = null;
        child.stdin = { end() {} };
        child.kill = () => {
            child.exitCode = 1;
            child.emit('exit', 1, null);
            return true;
        };
        session.client = client;
        session.clientReady = true;
        replClient = client;
        Object.defineProperty(session, 'lispProcess', { value: child, writable: true });
        Object.defineProperty(session, 'lispClient', {
            value: { process: child, client },
            writable: true
        });

        try {
            const quitting = session.quitLisp();
            const finished = await Promise.race([
                quitting.then(() => true),
                new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000))
            ]);
            assert.strictEqual(finished, true, 'quitLisp waited for the unresolved Swank RPC');
            assert.strictEqual(quitRequests, 1);
            assert.strictEqual(session.client, undefined);
            assert.strictEqual(session.clientReady, false);
            assert.strictEqual(replClient, undefined);
            assert.strictEqual(
                Object.getOwnPropertyDescriptor(session, 'lispProcess')?.value,
                undefined
            );
            assert.match(
                Object.getOwnPropertyDescriptor(session, 'statusBarItem')?.value.text,
                /Disconnected/
            );
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill();
            session.dispose();
            for (const subscription of subscriptions.reverse()) {
                subscription.dispose();
            }
        }
    });

    it('preserves a newer Swank connection while the local process quits', async () => {
        const originalConnect = Client.prototype.connect;
        const originalDisconnect = Client.prototype.disconnect;
        const originalInitialize = Client.prototype.initialize;
        const originalRex = Client.prototype.rex;
        const subscriptions: vscode.Disposable[] = [];
        let replClient: any;
        let resolveQuitRequested: (() => void) | undefined;
        const quitRequested = new Promise<void>(resolve => {
            resolveQuitRequested = resolve;
        });
        const replProvider = {
            focus: false,
            setClient(client: any) {
                replClient = client;
            },
            sendSystemSpecs() {}
        } as unknown as ReplView;
        const context = {
            extensionPath: '',
            subscriptions
        } as unknown as vscode.ExtensionContext;
        const session = new LispSession(context, replProvider, new Map());
        const child = new EventEmitter() as EventEmitter & {
            exitCode: number | null;
            signalCode: NodeJS.Signals | null;
            stdin: { end(): void };
            kill(): boolean;
        };
        child.exitCode = null;
        child.signalCode = null;
        child.stdin = { end() {} };
        child.kill = () => {
            child.exitCode = 1;
            child.emit('exit', 1, null);
            return true;
        };
        Object.defineProperty(session, 'lispProcess', { value: child, writable: true });
        Object.defineProperty(session, 'lispPort', { value: 4005, writable: true });
        Client.prototype.connect = async function() {
            this.connected = true;
        };
        Client.prototype.disconnect = function() {
            this.connected = false;
        };
        Client.prototype.initialize = async function() {
            return {};
        };
        Client.prototype.rex = function(command: string) {
            if (command === '(SWANK:QUIT-LISP)') {
                resolveQuitRequested?.();
                return new Promise<never>(() => {});
            }
            return Promise.resolve({ type: 'symbol', source: 'T' });
        };
        subscriptions.push(vscode.commands.registerCommand('olive.replView.open', () => {}));

        try {
            await session.connectTo('localhost', 4005);
            const localClient = session.client;
            const quitting = session.quitLisp();
            await quitRequested;

            session.disconnect();
            await session.connectTo('remote.example', 5005);
            const newerClient = session.client;
            assert.ok(session.clientReady);
            assert.strictEqual(replClient, newerClient);

            await quitting;

            assert.strictEqual(session.client, newerClient);
            assert.strictEqual(session.clientReady, true);
            assert.strictEqual(replClient, newerClient);
            assert.notStrictEqual(newerClient, localClient);
            assert.match(
                Object.getOwnPropertyDescriptor(session, 'statusBarItem')?.value.text,
                /Connected/
            );
            assert.strictEqual(
                Object.getOwnPropertyDescriptor(session, 'lispProcess')?.value,
                undefined
            );
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill();
            if (session.client) session.disconnect();
            session.dispose();
            for (const subscription of subscriptions.reverse()) {
                subscription.dispose();
            }
            Client.prototype.connect = originalConnect;
            Client.prototype.disconnect = originalDisconnect;
            Client.prototype.initialize = originalInitialize;
            Client.prototype.rex = originalRex;
        }
    });
});

describe('Lisp startup failure', () => {
    it('clears session state when the configured Lisp command cannot start', async () => {
        const config = vscode.workspace.getConfiguration('olive');
        const previousLispCommand = config.get<string>('lispCommand');
        await config.update(
            'lispCommand',
            'olive-test-missing-lisp-command',
            vscode.ConfigurationTarget.Global
        );

        const subscriptions: vscode.Disposable[] = [];
        let replClient: any;
        const replProvider = {
            focus: false,
            setClient(client: any) {
                replClient = client;
            },
            sendSystemSpecs() {}
        } as unknown as ReplView;
        const context = {
            extensionPath: '',
            subscriptions
        } as unknown as vscode.ExtensionContext;
        const session = new LispSession(context, replProvider, new Map());

        try {
            await session.startLisp();
            assert.strictEqual(session.clientReady, false);
            assert.strictEqual(session.client, undefined);
            assert.strictEqual(replClient, undefined);
            assert.strictEqual(
                Object.getOwnPropertyDescriptor(session, 'lispProcess')?.value,
                undefined
            );
            assert.match(
                Object.getOwnPropertyDescriptor(session, 'statusBarItem')?.value.text,
                /Disconnected/
            );
        } finally {
            session.dispose();
            for (const subscription of subscriptions.reverse()) {
                subscription.dispose();
            }
            await config.update(
                'lispCommand',
                previousLispCommand,
                vscode.ConfigurationTarget.Global
            );
        }
    });
});

describe('Lisp process event lifecycle', () => {
    it('ignores exit and error events from a superseded process', async () => {
        const childProcess = require('child_process');
        const originalSpawn = childProcess.spawn;
        const subscriptions: vscode.Disposable[] = [];
        let spawned = false;
        let replClient: any;
        const replProvider = {
            focus: false,
            setClient(client: any) {
                replClient = client;
            },
            sendSystemSpecs() {}
        } as unknown as ReplView;
        const context = {
            extensionPath: '',
            subscriptions
        } as unknown as vscode.ExtensionContext;
        const session = new LispSession(context, replProvider, new Map());
        const staleProcess = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            stdin: { write(text: string): boolean };
        };
        staleProcess.stdout = new EventEmitter();
        staleProcess.stderr = new EventEmitter();
        staleProcess.stdin = { write: () => true };
        childProcess.spawn = () => {
            spawned = true;
            return staleProcess;
        };
        let starting: Promise<void> | undefined;

        try {
            starting = session.startLisp();
            for (let attempt = 0; !spawned && attempt < 20; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            assert.strictEqual(spawned, true, 'Lisp process was not started');

            const client = { disconnect() {} };
            const newerProcess = new EventEmitter();
            session.client = client;
            session.clientReady = true;
            replProvider.setClient(client, undefined);
            Object.defineProperty(session, 'lispProcess', {
                value: newerProcess,
                writable: true
            });

            staleProcess.emit('exit', 1, null);
            staleProcess.emit('error', new Error('late process error'), undefined);

            assert.strictEqual(
                Object.getOwnPropertyDescriptor(session, 'lispProcess')?.value,
                newerProcess
            );
            assert.strictEqual(session.client, client);
            assert.strictEqual(session.clientReady, true);
            assert.strictEqual(replClient, client);
        } finally {
            childProcess.spawn = originalSpawn;
            Object.defineProperty(session, 'lispProcess', {
                value: undefined,
                writable: true
            });
            if (starting) await starting;
            session.dispose();
            for (const subscription of subscriptions.reverse()) {
                subscription.dispose();
            }
        }
    });
});

describe('Lisp and Swank process lifecycle', () => {
    it('keeps Lisp available after disconnect and reconnects for evaluation', async function() {
        this.timeout(45000);
        const extensionPath = process.env.OLIVE_TEST_EXTENSION_PATH;
        const lispCommand = process.env.OLIVE_TEST_LISP_COMMAND;
        if (!extensionPath || !lispCommand) this.skip();

        const config = vscode.workspace.getConfiguration('olive');
        const previousLispCommand = config.get<string>('lispCommand');
        await config.update('lispCommand', lispCommand, vscode.ConfigurationTarget.Global);

        const subscriptions: vscode.Disposable[] = [];
        let replClient: any;
        let port: number | undefined;
        const replProvider = {
            focus: false,
            setClient(client: any) {
                replClient = client;
            },
            sendSystemSpecs() {}
        } as unknown as ReplView;
        const context = {
            extensionPath,
            subscriptions
        } as unknown as vscode.ExtensionContext;
        const session = new LispSession(context, replProvider, new Map());
        subscriptions.push(vscode.commands.registerCommand('olive.replView.open', () => {}));

        const evaluateThirty = async () => {
            const client: any = session.client;
            if (!client) throw new Error('Swank client is unavailable');
            const result = await client.rex(
                '(SWANK:INTERACTIVE-EVAL "(+ 10 20)" 1 40)',
                'COMMON-LISP-USER',
                'T'
            );
            return util.from_lisp_string(result);
        };
        const assertThirty = async () => {
            const result = await Promise.race([
                evaluateThirty(),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Timed out evaluating Lisp form')), 10000))
            ]);
            assert.match(result, /^=> 30(?:\s|$)/);
        };

        try {
            await Promise.race([
                session.startLisp(),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Timed out starting Lisp')), 15000))
            ]);
            assert.strictEqual(session.clientReady, true);
            port = session.client.port;
            if (typeof port !== 'number') throw new Error('Swank client has no port');
            await assertThirty();

            const oldClient = session.client;
            session.disconnect();
            assert.strictEqual(session.client, undefined);
            assert.strictEqual(session.clientReady, false);
            assert.strictEqual(replClient, undefined);
            assert.match(
                Object.getOwnPropertyDescriptor(session, 'statusBarItem')?.value.text,
                /Disconnected/
            );
            for (let attempt = 0; oldClient.connected && attempt < 250; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.strictEqual(oldClient.connected, false, 'Old Swank socket did not close');

            await Promise.race([
                session.connectTo('localhost', port),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Timed out reconnecting')), 15000))
            ]);
            assert.strictEqual(session.clientReady, true);
            await assertThirty();

            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-file-workflow-'));
            const fileName = path.join(tempDir, 'olive-file-workflow.lisp');
            const errors: string[] = [];
            const information: string[] = [];
            const originalShowErrorMessage = vscode.window.showErrorMessage;
            const originalShowInformationMessage = vscode.window.showInformationMessage;
            vscode.window.showErrorMessage = ((message: string) => {
                errors.push(message);
                return Promise.resolve(undefined);
            }) as typeof vscode.window.showErrorMessage;
            vscode.window.showInformationMessage = ((message: string) => {
                information.push(message);
                return Promise.resolve(undefined);
            }) as typeof vscode.window.showInformationMessage;

            try {
                fs.writeFileSync(
                    fileName,
                    '(defun olive-test-add (a b)\n  (+ a b))\n',
                    'utf8'
                );
                const fileDocument = {
                    fileName,
                    uri: vscode.Uri.file(fileName),
                    isDirty: false,
                    getText: () => fs.readFileSync(fileName, 'utf8')
                } as vscode.TextDocument;
                const fileEditor = { document: fileDocument } as vscode.TextEditor;

                await session.compileFile(fileEditor, {} as vscode.TextEditorEdit);
                assert.deepStrictEqual(errors, []);
                assert.ok(information.some(message =>
                    message === 'Compiled and loaded olive-file-workflow.lisp.'
                ), `Unexpected compile/load notifications: ${JSON.stringify(information)}`);

                const client: any = session.client;
                if (!client) throw new Error('Swank client is unavailable after compilation');
                const result = await client.rex(
                    '(SWANK:INTERACTIVE-EVAL "(olive-test-add 20 22)" 1 40)',
                    'COMMON-LISP-USER',
                    'T'
                );
                assert.match(util.from_lisp_string(result), /^=> 42(?:\s|$)/);

                await session.loadFile(fileEditor, {} as vscode.TextEditorEdit);
                assert.deepStrictEqual(errors, []);
                assert.ok(information.some(message =>
                    message === 'Loaded olive-file-workflow.lisp.'
                ));

            } finally {
                vscode.window.showErrorMessage = originalShowErrorMessage;
                vscode.window.showInformationMessage = originalShowInformationMessage;
                await vscode.commands.executeCommand('workbench.action.closeAllEditors');
                for (const tempFile of fs.readdirSync(tempDir)) {
                    fs.unlinkSync(path.join(tempDir, tempFile));
                }
                fs.rmdirSync(tempDir);
            }

            await session.quitLisp();
            assert.strictEqual(session.client, undefined);
            assert.strictEqual(session.clientReady, false);
            assert.strictEqual(replClient, undefined);
            assert.match(
                Object.getOwnPropertyDescriptor(session, 'statusBarItem')?.value.text,
                /Disconnected/
            );
            assert.strictEqual(
                Object.getOwnPropertyDescriptor(session, 'lispProcess')?.value,
                undefined
            );
        } finally {
            const quitting = session.quitLisp();
            const quitFinished = await Promise.race([
                quitting.then(() => true),
                new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5000))
            ]);
            if (!quitFinished) {
                const child = Object.getOwnPropertyDescriptor(session, 'lispProcess')?.value;
                if (child && child.exitCode === null && child.signalCode === null) child.kill();
                if (session.client) session.client.disconnect();
                await Promise.race([
                    quitting,
                    new Promise<void>(resolve => setTimeout(resolve, 2000))
                ]);
            }
            session.dispose();
            for (const subscription of subscriptions.reverse()) {
                subscription.dispose();
            }
            await config.update(
                'lispCommand',
                previousLispCommand,
                vscode.ConfigurationTarget.Global
            );
        }
    });
});
