import * as vscode from 'vscode';
import { ReplView } from './replView';
import { LispSession } from './session';
import { OliveDocumentProvider } from './subr';
import { macrostepExpand, macrostepCollapse, macrostepClick } from './macrostep';

let session: LispSession;

export function activate(ctx: vscode.ExtensionContext) {
    const systemSpecs = new Map();
    const replProvider = new ReplView(ctx, systemSpecs);
    const config = vscode.workspace.getConfiguration('olive');
    session = new LispSession(ctx, replProvider, systemSpecs);

    const provider = OliveDocumentProvider.getInstance();
    ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("olive", provider));

    ctx.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ReplView.viewType, replProvider,
            { webviewOptions: { retainContextWhenHidden: true } })
    );

    ctx.subscriptions.push(
        vscode.commands.registerTextEditorCommand('olive.macrostep', (editor) => macrostepExpand(session, editor)),
        vscode.commands.registerTextEditorCommand('olive.macrostepCollapse', (editor) => macrostepCollapse(editor)),
    );

    const selector: vscode.DocumentSelector = { language: 'common-lisp' };
    ctx.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, session, ':', '*', '+'));
    ctx.subscriptions.push(vscode.languages.registerHoverProvider(selector, session));
    ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, session));
    ctx.subscriptions.push(vscode.languages.registerReferenceProvider(selector, session));
    ctx.subscriptions.push(vscode.languages.registerSignatureHelpProvider(selector, session, ' ', '('));
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

    let prevEditor: vscode.TextEditor | undefined;
    let prevSelection: vscode.Selection | undefined;
    let prevTime = 0;

    ctx.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async (e) => {
            if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
                prevTime = 0;
                return;
            }
            let doubleClickPos: vscode.Position | undefined;
            if (prevEditor === e.textEditor
                && prevSelection
                && prevSelection.isEmpty
                && e.selections.length === 1
                && e.selections[0].start.line === prevSelection.start.line
                && Date.now() - prevTime <= config.get('doubleClickInterval', 600))
                doubleClickPos = prevSelection.start;
            prevEditor = e.textEditor;
            prevSelection = e.selections[0];
            prevTime = Date.now();
            if (doubleClickPos)
                await macrostepClick(session, prevEditor, doubleClickPos);
        }))

    if (config.get('autostart')) {
        session.startLisp();
    }
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', 'olive.activeLangId', undefined);
    session?.dispose();
}
