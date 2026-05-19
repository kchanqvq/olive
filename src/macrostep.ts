import * as vscode from 'vscode';
import { LispSession } from './session';
import { OliveDocumentProvider, searchBufferPackage, getTopLevelForm } from './subr';
const { util } = require('swank-client');
const paredit = require('paredit.js');

type NRange = { from: number, to: number };
const linkMap: WeakMap<vscode.TextDocument, NRange[]> = new WeakMap();
const linkDecorationType = vscode.window.createTextEditorDecorationType({ textDecoration: 'underline' });
type Original = { from:number, to:number, text: string, links: NRange[] };
const originalMap: WeakMap<vscode.TextDocument, Original[]> = new WeakMap();

function convertNRange(doc: vscode.TextDocument, {from, to}: NRange) {
    return new vscode.Range(doc.positionAt(from), doc.positionAt(to));
}

function moveLinks(src: NRange[], dst: NRange[], from: number, to: number, delta: number): NRange[] {
    const deadLinks: NRange[] = []
    for (const link of src) {
        if (link.to <= from) {
            dst.push(link);
        } else if (link.from >= to) {
            dst.push({ from: link.from + delta, to: link.to + delta });
        } else {
            deadLinks.push({ from: link.from - from, to: link.to - from });
        }
    }
    return deadLinks;
}

function moveOriginals(src: Original[], dst: Original[], from: number, to: number, delta: number) {
    for (const o of src) {
        if ((o.from >= to || o.from <= from) &&
            (o.to >= to || o.to <= from)
        ) {
            const newFrom = o.from <= from ? o.from : o.from + delta;
            const newTo = o.to <= from ? o.to : o.to + delta;
            dst.push({ from: newFrom, to: newTo, text: o.text, links: o.links });
        }
    }
}

async function showExpansion(content: string, pos: vscode.Position, viewColumn: vscode.ViewColumn | undefined,
    links: NRange[], originals: Original[]
) {
    const uri = OliveDocumentProvider.getInstance().set(content, "Macro Expansion");
    const newDoc = await vscode.workspace.openTextDocument(uri);
    linkMap.set(newDoc, links);
    originalMap.set(newDoc, originals);
    const newEditor = await vscode.window.showTextDocument(newDoc,
        { viewColumn, preview: true, selection: new vscode.Range(pos, pos) });
    newEditor.setDecorations(linkDecorationType, links.map(r => convertNRange(newDoc, r)))
    for (const original of originals) {
        newEditor.setDecorations(vscode.window.createTextEditorDecorationType({ backgroundColor: 'var(--vscode-editor-inactiveSelectionBackground)' }),
            [convertNRange(newDoc, original)]);
    }
}

export async function macrostepExpand(session: LispSession, editor: vscode.TextEditor, position?: vscode.Position) {
    if (!session.checkClient()) return;

    const doc = editor.document, pos = position || editor.selection.active;
    const pkg = searchBufferPackage(doc, pos);

    const text = doc.getText();
    const ast = paredit.parse(text);
    const offset = doc.offsetAt(pos);
    const nodes = paredit.walk.sexpsAt(ast, offset);

    // Find the innermost list that contains the cursor
    let node = nodes.reverse().find((n: any) => n.type === 'list');

    if (!node) {
        vscode.window.showErrorMessage('No macro form found at cursor');
        return;
    }

    const range = new vscode.Range(doc.positionAt(node.start), doc.positionAt(node.end));
    const topRange = getTopLevelForm(doc, range.start, ast);
    const form = doc.getText(range);
    const context = topRange ?
        `'(${doc.getText(new vscode.Range(topRange.start, range.start))} ${doc.getText(new vscode.Range(range.end, topRange.end))})`
        : 'NIL'

    const res = await session.client.rex(`(SWANK-MACROSTEP:MACROSTEP-EXPAND-1 ${util.to_lisp_string(form)} NIL ${context})`, pkg, 'T');

    if (res.children[0].source.toLowerCase() === ':ok') {
        const expansion = util.from_lisp_string(res.children[1]);
        const indented = expansion.split('\n').join('\n' + ' '.repeat(range.start.character))
        const newContent = text.substring(0, node.start) + indented + text.substring(node.end);
        const delta = indented.length - (node.end - node.start)

        const links: NRange[] = [];
        const subforms = util.from_lisp_bool(res.children[2]) ? res.children[2].children : [];
        for (const subform of subforms) {
            const name = util.from_lisp_string(subform.children[0]);
            // this assumes that the operator starts right next to the
            // opening parenthesis. This is as robust as SLIME
            const offset = Number(subform.children[2].source) + 1;
            const docOffset = node.start + offset +
                (expansion.substring(0, offset).split('\n').length - 1) * range.start.character
            links.push({from: docOffset, to: docOffset + name.length});
        }

        const original: Original = {from: node.start, to: node.end + delta, text: form,
            links: moveLinks(linkMap.get(doc) || [], links, node.start, node.end, delta)};
        const originals = [original];
        moveOriginals(originalMap.get(doc) || [], originals, node.start, node.end, delta);

        await showExpansion(newContent, range.start, editor.viewColumn, links, originals);
    } else if (res.children[0].source.toLowerCase() === ':error') {
        vscode.window.showErrorMessage(`Expand macro error: ${util.from_lisp_string(res.children[1])}`);
    }
}

export async function macrostepCollapse(editor: vscode.TextEditor, position?: vscode.Position) {
    const doc = editor.document, pos = position || editor.selection.active;
    const offset = doc.offsetAt(pos);

    const originals = originalMap.get(doc);
    if (originals && originals.length > 0) {
        const original = originals.filter(o => o.from <= offset && offset <= o.to)
            .sort((x, y) => (x.to - x.from) - (y.to - y.from))[0];
        const text = doc.getText();
        const newContent = text.substring(0, original.from) + original.text + text.substring(original.to);
        const delta = original.text.length - (original.to - original.from);

        const links: NRange[] = [];
        for (const {from, to} of original.links) {
            links.push({from: from + original.from, to: to + original.from});
        }

        moveLinks(linkMap.get(doc) || [], links, original.from, original.to, delta);
        const newOriginals: Original[] = [];
        moveOriginals(originals.filter(o => o !== original), newOriginals, original.from, original.to, delta);

        // Close "Macro Expansion" window if there're no more expansion.
        // Assume macrostepCollapse is only ever run from "Macro Expansion" window.
        if (!newOriginals.length) {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            return;
        }

        await showExpansion(newContent, doc.positionAt(original.from), editor.viewColumn, links, newOriginals);
    }
    else {
        vscode.window.showErrorMessage(`No expanded macro at cursor`);
    }
}

export async function macrostepClick(session: LispSession, editor: vscode.TextEditor, position: vscode.Position) {
    const doc = editor.document, offset = doc.offsetAt(position);
    const links = linkMap.get(editor.document) || [];
    if (links.find(r => r.from <= offset && offset <= r.to))
        macrostepExpand(session, editor, position)
    else
        macrostepCollapse(editor, position);
}
