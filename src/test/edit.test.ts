import * as vscode from 'vscode';
import * as assert from 'assert';

const SOURCE = `(defun foo (a b)\n  (bar '(1 2) "s"))`;

let editor: vscode.TextEditor;

// Offset of the first character of NEEDLE in SOURCE.
function at(needle: string): number {
    const i = SOURCE.indexOf(needle);
    assert.notStrictEqual(i, -1, `no ${needle} in sample`);
    return i;
}

async function motion(command: string, from: number): Promise<number> {
    const pos = editor.document.positionAt(from);
    editor.selection = new vscode.Selection(pos, pos);
    await vscode.commands.executeCommand(command);
    return editor.document.offsetAt(editor.selection.active);
}

describe('Structural navigation', () => {
    before(async function() {
        this.timeout(60000);
        await vscode.extensions.getExtension('kchanqvq.olive')!.activate();
        const doc = await vscode.workspace.openTextDocument({ language: 'common-lisp', content: SOURCE });
        editor = await vscode.window.showTextDocument(doc);
    });

    it('moves over the whole top level form', async () => {
        assert.strictEqual(await motion('olive.forwardSexp', 0), SOURCE.length);
        assert.strictEqual(await motion('olive.backwardSexp', SOURCE.length), 0);
    });

    it('moves over a sibling expression', async () => {
        assert.strictEqual(await motion('olive.forwardSexp', at('a b')), at(' b)'));
        assert.strictEqual(await motion('olive.backwardSexp', at(' b)')), at('a b'));
    });

    it('moves into and out of lists', async () => {
        assert.strictEqual(await motion('olive.downList', 0), at('defun'));
        assert.strictEqual(await motion('olive.backwardUpList', at('bar')), at('(bar'));
        assert.strictEqual(await motion('olive.forwardUpList', at('bar')), at('))') + 1);
    });

    it('treats a reader prefix as part of its form', async () => {
        // from just after (1 2), back over the quote too
        assert.strictEqual(await motion('olive.backwardSexp', at(' "s"')), at("'(1 2)"));
    });

    // Cases below are written in paredit.el's notation, | being the cursor.
    it('extends the selection when asked to', async () => {
        const pos = editor.document.positionAt(at('bar'));
        editor.selection = new vscode.Selection(pos, pos);
        await vscode.commands.executeCommand('olive.forwardSexp', { select: true });
        assert.strictEqual(editor.document.getText(editor.selection), 'bar');
        await vscode.commands.executeCommand('olive.forwardSexp', { select: true });
        assert.strictEqual(editor.document.getText(editor.selection), `bar '(1 2)`);
    });
});

// CONTENT and the result are in paredit.el's notation, | being the cursor.
async function afterDelete(content: string, forward: boolean): Promise<string> {
    const offset = content.indexOf('|');
    const doc = await vscode.workspace.openTextDocument(
        { language: 'common-lisp', content: content.replace('|', '') });
    const ed = await vscode.window.showTextDocument(doc);
    const pos = doc.positionAt(offset);
    ed.selection = new vscode.Selection(pos, pos);
    await vscode.commands.executeCommand(forward ? 'olive.forwardDelete' : 'olive.backwardDelete');
    const text = doc.getText(), cursor = doc.offsetAt(ed.selection.active);
    return text.slice(0, cursor) + '|' + text.slice(cursor);
}

describe('Strict delete', () => {
    before(async function() {
        this.timeout(60000);
        await vscode.extensions.getExtension('kchanqvq.olive')!.activate();
    });

    it('deletes an ordinary character', async () => {
        assert.strictEqual(await afterDelete('(quu|x "zot")', true), '(quu| "zot")');
        assert.strictEqual(await afterDelete('("zot" q|uux)', false), '("zot" |uux)');
    });

    it('moves over a delimiter instead of deleting it', async () => {
        assert.strictEqual(await afterDelete('|(foo bar)', true), '(|foo bar)');
        assert.strictEqual(await afterDelete('(quux |"zot")', true), '(quux "|zot")');
        assert.strictEqual(await afterDelete('(foo bar)|', false), '(foo bar|)');
        assert.strictEqual(await afterDelete('("zot"| quux)', false), '("zot|" quux)');
    });

    it('deletes an empty form whole', async () => {
        assert.strictEqual(await afterDelete('(foo (|) bar)', true), '(foo | bar)');
        assert.strictEqual(await afterDelete('(foo (|) bar)', false), '(foo | bar)');
        assert.strictEqual(await afterDelete('(foo "|" bar)', true), '(foo | bar)');
    });

    it('refuses to delete a delimiter that would unbalance', async () => {
        assert.strictEqual(await afterDelete('(foo|)', true), '(foo|)');
        assert.strictEqual(await afterDelete('(|foo)', false), '(|foo)');
        assert.strictEqual(await afterDelete('("|zot" quux)', false), '("|zot" quux)');
    });
});
