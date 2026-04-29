import * as vscode from 'vscode';
import { ReplView } from './replView';
import { LispSession } from './session';
import { OliveTextProvider } from './subr';

let session: LispSession;

export function activate(ctx: vscode.ExtensionContext) {
    const systemSpecs = new Map();
    const replProvider = new ReplView(ctx, systemSpecs);
    session = new LispSession(ctx, replProvider, systemSpecs);

    ctx.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(OliveTextProvider.scheme, OliveTextProvider.getInstance())
    );

    ctx.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ReplView.viewType, replProvider,
            { webviewOptions: { retainContextWhenHidden: true } })
    );

    const selector: vscode.DocumentSelector = { scheme: 'file', language: 'common-lisp' };
    ctx.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, session, ':', '*', '+'));
    ctx.subscriptions.push(vscode.languages.registerHoverProvider(selector, session));
    ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, session));
    ctx.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(selector, session));
    ctx.subscriptions.push(vscode.languages.registerDocumentRangeFormattingEditProvider(selector, session));

    // olive.activeLangId is like editorLangId but persist when editor lose focus
    const updateLanguageContext = (editor?: vscode.TextEditor) => {
        vscode.commands.executeCommand('setContext', 'olive.activeLangId', editor?.document.languageId);
    };
    updateLanguageContext(vscode.window.activeTextEditor);
    ctx.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateLanguageContext)
    );

    if (vscode.workspace.getConfiguration('olive').get('autostart')) {
        session.startLisp();
    }
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', 'olive.activeLangId', undefined);
    session?.dispose();
}
