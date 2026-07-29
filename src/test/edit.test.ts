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

    it('moves into an empty form rather than deleting it from outside', async () => {
        assert.strictEqual(await afterDelete('(foo ()| bar)', false), '(foo (|) bar)');
        assert.strictEqual(await afterDelete('(foo |() bar)', true), '(foo (|) bar)');
        assert.strictEqual(await afterDelete('(foo ""| bar)', false), '(foo "|" bar)');
        assert.strictEqual(await afterDelete('(foo |"" bar)', true), '(foo "|" bar)');
    });

    it('refuses to delete a delimiter that would unbalance', async () => {
        assert.strictEqual(await afterDelete('(foo|)', true), '(foo|)');
        assert.strictEqual(await afterDelete('(|foo)', false), '(|foo)');
        assert.strictEqual(await afterDelete('("|zot" quux)', false), '("|zot" quux)');
    });
});

async function afterCommand(content: string, command: string): Promise<string> {
    const offset = content.indexOf('|');
    const doc = await vscode.workspace.openTextDocument(
        { language: 'common-lisp', content: content.replace('|', '') });
    const ed = await vscode.window.showTextDocument(doc);
    const pos = doc.positionAt(offset);
    ed.selection = new vscode.Selection(pos, pos);
    await vscode.commands.executeCommand(command);
    const text = doc.getText(), cursor = doc.offsetAt(ed.selection.active);
    return text.slice(0, cursor) + '|' + text.slice(cursor);
}

describe('Structural edits', () => {
    before(async function() {
        this.timeout(60000);
        await vscode.extensions.getExtension('kchanqvq.olive')!.activate();
    });

    it('slurps', async () => {
        assert.strictEqual(await afterCommand('(foo (bar|) baz)', 'olive.forwardSlurp'),
            '(foo (bar| baz))');
        assert.strictEqual(await afterCommand('(foo (|bar) baz)', 'olive.backwardSlurp'),
            '((foo |bar) baz)');
    });

    it('barfs', async () => {
        assert.strictEqual(await afterCommand('(foo (bar| baz))', 'olive.forwardBarf'),
            '(foo (bar|) baz)');
        assert.strictEqual(await afterCommand('((foo |bar) baz)', 'olive.backwardBarf'),
            '(foo (|bar) baz)');
    });

    it('splices and splits', async () => {
        assert.strictEqual(await afterCommand('(foo (bar| baz) quux)', 'olive.spliceSexp'),
            '(foo bar| baz quux)');
        assert.strictEqual(await afterCommand('(foo bar| baz)', 'olive.splitSexp'),
            '(foo bar)| ( baz)');
    });

    it('treats a reader prefix as part of its form', async () => {
        assert.strictEqual(await afterCommand("(foo (bar|) 'baz)", 'olive.forwardSlurp'),
            "(foo (bar| 'baz))");
        assert.strictEqual(await afterCommand("(foo (bar| 'baz))", 'olive.forwardBarf'),
            "(foo (bar|) 'baz)");
        assert.strictEqual(await afterCommand("(foo |'bar baz)", 'olive.wrapAround'),
            "(foo (|'bar) baz)");
        assert.strictEqual(await afterCommand("(foo |#'bar baz)", 'olive.forwardKillSexp'),
            '(foo | baz)');
    });

    it('wraps and kills', async () => {
        assert.strictEqual(await afterCommand('(foo |bar baz)', 'olive.wrapAround'),
            '(foo (|bar) baz)');
        assert.strictEqual(await afterCommand('(foo |bar baz)', 'olive.forwardKillSexp'),
            '(foo | baz)');
    });
    it('splices and kills', async () => {
        // paredit.el's M-<up> and M-<down> examples
        assert.strictEqual(
            await afterCommand('(foo (let ((x 5)) |(sqrt n)) bar)', 'olive.backwardSpliceKill'),
            '(foo |(sqrt n) bar)');
        assert.strictEqual(
            await afterCommand('(a (b c| d e) f)', 'olive.forwardSpliceKill'), '(a b c| f)');
    });

    it('breaks the line so a semicolon cannot comment out a delimiter', async () => {
        const semi = (c: string) => afterCommand(c, 'olive.insertSemicolon');
        assert.strictEqual(await semi('|(frob grovel)'), ';|(frob grovel)');
        assert.strictEqual(await semi('(frob |grovel)'), '(frob ;|grovel\n )');
        assert.strictEqual(await semi('(frob grovel)          |'), '(frob grovel)          ;|');
        // only the edited range is reindented, so `zargh` keeps its column
        assert.strictEqual(await semi('(frob |grovel (bloit\n               zargh))'),
            '(frob ;|grovel\n (bloit\n               zargh))');
        assert.strictEqual(await semi('(foo "a|b")'), '(foo "a;|b")');
    });

    it('raises', async () => {
        // the chain from paredit.el's own M-r example
        assert.strictEqual(
            await afterCommand('(dynamic-wind in (lambda () |body) out)', 'olive.raiseSexp'),
            '(dynamic-wind in |body out)');
        assert.strictEqual(
            await afterCommand('(dynamic-wind in |body out)', 'olive.raiseSexp'), '|body');
        assert.strictEqual(
            await afterCommand("(foo (bar |'baz) quux)", 'olive.raiseSexp'), "(foo |'baz quux)");
        // the cursor lands at the start of the raised form, as in Emacs
        assert.strictEqual(
            await afterCommand('(foo (bar ba|z) quux)', 'olive.raiseSexp'), '(foo |baz quux)');
    });

    it('reindents what it moved', async () => {
        assert.strictEqual(await afterCommand('(foo (bar|)\n     baz)', 'olive.forwardSlurp'),
            '(foo (bar|\n      baz))');
        assert.strictEqual(await afterCommand('(foo (bar|\n          baz))', 'olive.forwardBarf'),
            '(foo (bar|)\n     baz)');
    });
});
