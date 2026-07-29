import * as vscode from 'vscode';
import { getAst } from './subr';
import { LispSession } from './session';
const paredit = require('paredit.js');

type Motion = (ast: any, offset: number) => number | undefined;
type Change = [string, number, any];
type Result = { changes: Change[], newIndex: number } | null;
type Edit = (ast: any, text: string, offset: number) => Result;

// Paredit's changes apply one after another, some positioned as if the earlier
// ones already did, so apply them to the text and replace what differs.
function replacement(text: string, changes: Change[]) {
    let out = text;
    for (const [op, at, arg] of changes)
        out = op === 'insert' ? out.slice(0, at) + arg + out.slice(at)
            : out.slice(0, at) + out.slice(at + arg);

    let start = 0;
    while (start < out.length && start < text.length && out[start] === text[start]) start++;
    let tail = 0;
    while (tail < out.length - start && tail < text.length - start
        && out[out.length - 1 - tail] === text[text.length - 1 - tail]) tail++;
    return { start, end: text.length - tail, text: out.slice(start, out.length - tail) };
}

function raiseSexp(ast: any, text: string, offset: number): Result {
    const w = paredit.walk;
    const parents = w.containingSexpsAt(ast, offset, w.hasChildren);
    const parent = parents[parents.length - 1];
    if (!parent || parent.type === 'toplevel') return null;
    const child = parent.children.find((n: any) => n.start <= offset && offset <= n.end)
        || parent.children.find((n: any) => n.start >= offset);
    if (!child) return null;
    const start = w.skipSpecials(ast, child, true), end = w.skipSpecials(ast, child);
    return {
        changes: [['remove', end, parent.end - end],
            ['remove', parent.start, start - parent.start]],
        newIndex: parent.start
    };
}

// Where to break the line so that a semicolon at OFFSET does not comment out
// a closing delimiter, or null when there is nothing to save.
function lineBreakForSemicolon(ast: any, text: string, offset: number): number | null {
    const w = paredit.walk;
    const eol = text.indexOf('\n', offset) < 0 ? text.length : text.indexOf('\n', offset);
    if (offset >= eol) return null;
    for (let pos = offset; ;) {
        const node = w.nextSexp(ast, pos);
        if (!node) {
            const rest = text.slice(pos, eol);
            // Only whitespace or an existing comment is safe to comment out.
            return /^\s*$/.test(rest) || /^\s*;/.test(rest) ? null : pos;
        }
        if (w.skipSpecials(ast, node, true) > eol) return null;
        if (node.end > eol) return pos;
        pos = node.end;
    }
}

function insertSemicolon(ast: any, text: string, offset: number): Result {
    const inside = paredit.walk.containingSexpsAt(ast, offset).pop();
    const at = inside && inside.type === 'char' ? inside.start : offset;
    if (inside && ['string', 'comment', 'char'].includes(inside.type))
        return { changes: [['insert', at, ';']], newIndex: at + 1 };

    const breakAt = lineBreakForSemicolon(ast, text, offset);
    const changes: Change[] = [['insert', offset, ';']];
    // The semicolon has already shifted everything after it by one.
    if (breakAt !== null) changes.push(['insert', breakAt + 1, '\n']);
    return { changes, newIndex: offset + 1 };
}

export class EditProvider {
    constructor(ctx: vscode.ExtensionContext, private session: LispSession) {
        const motion = (command: string, move: Motion) =>
            vscode.commands.registerTextEditorCommand(command,
                (editor, edit, args) => this.move(editor, move, args?.select));
        // Not registerTextEditorCommand: it ignores the promise we return, so
        // callers could not tell when the edit has been applied.
        const edit = (command: string, change: Edit) =>
            vscode.commands.registerCommand(command, () => this.apply(change));

        const ed = paredit.editor;
        ctx.subscriptions.push(
            motion('olive.forwardSexp', paredit.navigator.forwardSexp),
            motion('olive.backwardSexp', paredit.navigator.backwardSexp),
            motion('olive.downList', paredit.navigator.forwardDownSexp),
            motion('olive.backwardUpList', paredit.navigator.backwardUpSexp),
            motion('olive.forwardUpList', paredit.navigator.closeList),

            edit('olive.forwardSlurp', (a, s, i) => ed.slurpSexp(a, s, i, {})),
            edit('olive.backwardSlurp', (a, s, i) => ed.slurpSexp(a, s, i, { backward: true })),
            edit('olive.forwardBarf', (a, s, i) => ed.barfSexp(a, s, i, {})),
            edit('olive.backwardBarf', (a, s, i) => ed.barfSexp(a, s, i, { backward: true })),
            edit('olive.spliceSexp', (a, s, i) => ed.spliceSexp(a, s, i)),
            edit('olive.forwardSpliceKill', (a, s, i) => ed.spliceSexpKill(a, s, i, {})),
            edit('olive.backwardSpliceKill', (a, s, i) => ed.spliceSexpKill(a, s, i, { backward: true })),
            edit('olive.splitSexp', (a, s, i) => ed.splitSexp(a, s, i)),
            edit('olive.wrapAround', (a, s, i) => ed.wrapAround(a, s, i, '(', ')')),
            edit('olive.raiseSexp', raiseSexp),
            edit('olive.forwardKillSexp', (a, s, i) => ed.killSexp(a, s, i, {})),
            edit('olive.backwardKillSexp', (a, s, i) => ed.killSexp(a, s, i, { backward: true })),

            edit('olive.insertSemicolon', insertSemicolon),

            vscode.commands.registerCommand('olive.forwardDelete', () => this.delete(true)),
            vscode.commands.registerCommand('olive.backwardDelete', () => this.delete(false)));
    }

    private async apply(change: Edit) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const doc = editor.document, ast = getAst(doc), text = doc.getText();
        const offsets = editor.selections.map(sel => doc.offsetAt(sel.active));
        await this.applyResults(editor, text, offsets,
            offsets.map(offset => change(ast, text, offset)));
    }

    private async applyResults(editor: vscode.TextEditor, text: string,
        offsets: number[], results: Result[]) {
        const doc = editor.document;
        const spans = results.map(r => r && r.changes.length ? replacement(text, r.changes) : null);

        if (spans.some(Boolean))
            await editor.edit(edit => spans.forEach(span => span && edit.replace(
                new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end)), span.text)),
                { undoStopBefore: true, undoStopAfter: false });

        editor.selections = editor.selections.map((sel, i) => {
            const result = results[i];
            if (!result) return sel;
            // With a single cursor the document is what paredit computed, so
            // its index applies as is. With several, only a cursor that moved
            // without changing anything can be placed reliably; VS Code has
            // adjusted the others for the edits.
            if (results.length === 1) return selectionAt(doc, result.newIndex);
            if (result.changes.length) return sel;
            return selectionAt(doc, doc.offsetAt(sel.active) + result.newIndex - offsets[i]);
        });

        // Moving text between lines leaves it indented for where it was, so
        // reindent what we touched. The cursor is already placed, VS Code
        // moves it along with the indentation.
        const indents = spans.flatMap(span => span ? this.session.provideDocumentRangeFormattingEdits(
            doc, new vscode.Range(doc.positionAt(span.start),
                doc.positionAt(span.start + span.text.length))) : []);
        if (indents.length)
            await editor.edit(edit => indents.forEach(e => edit.replace(e.range, e.newText)),
                { undoStopBefore: false, undoStopAfter: true });

        editor.revealRange(editor.selection);
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

        // Leave removing a single character to VS Code, which knows about
        // indentation, auto-closing pairs and the like.
        if (results.every((r: any, i: number) => r.changes.length === 1
            && r.changes[0][2] === 1
            && r.changes[0][1] === (forward ? offsets[i] : offsets[i] - 1))) return native();

        await this.applyResults(editor, text, offsets, results);
    }

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

function selectionAt(doc: vscode.TextDocument, offset: number): vscode.Selection {
    const pos = doc.positionAt(offset);
    return new vscode.Selection(pos, pos);
}
