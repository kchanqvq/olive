import * as vscode from 'vscode';
import { getAst } from './subr';
const paredit = require('paredit.js');

// Motions return the new offset, or undefined to leave the cursor alone.
type Motion = (ast: any, offset: number) => number | undefined;

// Paredit asks to remove a single character, which VS Code does better itself.
function isPlain(result: any, offset: number, forward: boolean): boolean {
    const [change] = result.changes;
    return result.changes.length === 1 && change[2] === 1
        && change[1] === (forward ? offset : offset - 1);
}

export class EditProvider {
    constructor(ctx: vscode.ExtensionContext) {
        const motion = (command: string, move: Motion) =>
            vscode.commands.registerTextEditorCommand(command,
                (editor, edit, args) => this.move(editor, move, args?.select));

        ctx.subscriptions.push(
            motion('olive.forwardSexp', paredit.navigator.forwardSexp),
            motion('olive.backwardSexp', paredit.navigator.backwardSexp),
            motion('olive.downList', paredit.navigator.forwardDownSexp),
            motion('olive.backwardUpList', paredit.navigator.backwardUpSexp),
            motion('olive.forwardUpList', paredit.navigator.closeList),
            // Not registerTextEditorCommand: it ignores the promise we return,
            // so callers could not tell when the edit has been applied.
            vscode.commands.registerCommand('olive.forwardDelete', () => this.delete(true)),
            vscode.commands.registerCommand('olive.backwardDelete', () => this.delete(false)));
    }

    private async delete(forward: boolean) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const native = () => vscode.commands.executeCommand(forward ? 'deleteRight' : 'deleteLeft');
        // A selection is deleted as it is, like paredit's delete-region.
        if (editor.selections.some(sel => !sel.isEmpty)) return native();

        const doc = editor.document, ast = getAst(doc), text = doc.getText();
        const offsets = editor.selections.map(sel => doc.offsetAt(sel.active));
        const results = offsets.map(offset =>
            paredit.editor.delete(ast, text, offset, { backward: !forward }));

        // Leave plain deletions to VS Code, which knows about indentation,
        // auto-closing pairs and the like.
        if (results.every((r: any, i: number) => isPlain(r, offsets[i], forward))) return native();

        if (results.some((r: any) => r.changes.length))
            await editor.edit(edit => results.forEach((r: any) => r.changes.forEach(
                (change: [string, number, number]) => edit.delete(new vscode.Range(
                    doc.positionAt(change[1]), doc.positionAt(change[1] + change[2]))))));

        // A result without changes may still move the cursor over a delimiter.
        // The rest VS Code has already placed at the start of the deletion.
        editor.selections = editor.selections.map((sel, i) => {
            if (results[i].changes.length) return sel;
            const pos = doc.positionAt(doc.offsetAt(sel.active) + results[i].newIndex - offsets[i]);
            return new vscode.Selection(pos, pos);
        });
    }

    // SELECT extends the selection instead of moving the cursor, for the
    // shifted variant of each keybinding.
    private move(editor: vscode.TextEditor, move: Motion, select = false) {
        const doc = editor.document, ast = getAst(doc);
        editor.selections = editor.selections.map(sel => {
            const offset = move(ast, doc.offsetAt(sel.active));
            if (offset === undefined) return sel;
            const active = doc.positionAt(offset);
            return new vscode.Selection(select ? sel.anchor : active, active);
        });
        editor.revealRange(editor.selection);
    }
}
