import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {IndentSpec} from './indent'
const { util } = require('swank-client');
const paredit = require('paredit.js');

export const kindTable: Record<string, vscode.CompletionItemKind> = {
    b: vscode.CompletionItemKind.Variable,
    f: vscode.CompletionItemKind.Function,
    g: vscode.CompletionItemKind.Method,
    t: vscode.CompletionItemKind.Interface,
    c: vscode.CompletionItemKind.Class,
    m: vscode.CompletionItemKind.Operator,
    s: vscode.CompletionItemKind.Keyword,
    p: vscode.CompletionItemKind.Module,
    a: vscode.CompletionItemKind.Property
};

export const severityOrder: string[] = ["read-error", "error", "warning",
    "final-deprecation-warning", "late-deprecation-warning", "redefinition",
    "style-warning", "early-deprecation-warning", "note"];

export function plistGet(sexp: any, key: string): any {
    if (util.from_lisp_bool(sexp)) {
        for (let i = 0; i < sexp.children.length; i += 2) {
            if (sexp.children[i].source.toLowerCase() === key) {
                return sexp.children[i + 1];
            }
        }
    }
    return sexp;
}

export function convertSeverity(severity: string): vscode.DiagnosticSeverity {
    const i = severityOrder.indexOf(severity);
    if (i <= severityOrder.indexOf('final-deprecation-warning'))
        return vscode.DiagnosticSeverity.Error;
    if (i <= severityOrder.indexOf('style-warning'))
        return vscode.DiagnosticSeverity.Warning;
    return vscode.DiagnosticSeverity.Information;
}

export function convertPosition(doc: vscode.TextDocument, sexp: any): vscode.Position {
    const type = sexp.children[0].source.toLowerCase();
    if (type === ':position') {
        return doc.positionAt(Number(sexp.children[1].source) - 1);
    } else if (type === ':offset') {
        return doc.positionAt(Number(sexp.children[1].source) - 1 + Number(sexp.children[2].source));
    } else if (type === ':line') {
        return new vscode.Position(Number(sexp.children[1].source) - 1,
            util.from_lisp_bool(sexp.children[2]) ? Number(sexp.children[2].source) - 1 : 0);
    } else if (type === ':eof') {
        return doc.lineAt(doc.lineCount - 1).range.end;
    } else {
        console.log('convertPosition unimplemented: ', sexp);
        return new vscode.Position(0,0);
    }
}

function sexpRange(text: string): [number, number | undefined]{
    let stringp = false, depth = 0, start = -1;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (stringp) {
            if (c === '\\') i++;
            else if (c === '"') {
                stringp = false;
                depth--;
                if (depth <= 0) return [start, i];}
        } else {
            switch (c) {
                case ';': return [start, undefined];
                case '\\': i++; break;
                case '(':
                    if (start < 0) start = i;
                    depth++;
                    break;
                case ')':
                    depth--;
                    if (depth <= 0) return [start, i];
                    break;
                case '"':
                    if (start < 0) start = i;
                    depth++;
                    stringp = true;
                    break;
            }
        }
    }
    return [start, undefined];
}

export function convertCompilerNote(doc: vscode.TextDocument, sexp: any): vscode.Diagnostic {
    const message = util.from_lisp_string(plistGet(sexp, ':message'));
    const severity = convertSeverity(plistGet(sexp, ':severity').source.slice(1).toLowerCase());
    const position = convertPosition(doc, plistGet(sexp, ':location').children[2]);
    const lineEnd = doc.lineAt(position).range.end;
    const textAfter = doc.getText(new vscode.Range(position, lineEnd));
    const [sexpStart, sexpEnd] = sexpRange(textAfter);
    if (sexpEnd) {
        return new vscode.Diagnostic(new vscode.Range(position, position.translate(0, sexpEnd)),
            message, severity);
    } else {
        const wordRange = doc.getWordRangeAtPosition(position.translate(0, sexpStart + 1));
        return new vscode.Diagnostic(wordRange || new vscode.Range(position, position),
            message, severity);
    }
}

export function convertCompletionItem(sexp: any): vscode.CompletionItem {
    const text = util.from_lisp_string(sexp.children[0]);
    let kind = vscode.CompletionItemKind.Text;
    for (const char of util.from_lisp_string(sexp.children[1])) {
        kind = kindTable[char] || kind;
    }
    return new vscode.CompletionItem(text, kind);
}

export async function convertLocation(location: any): Promise<vscode.Location | undefined> {
    const buffer = location.children[1];
    if (buffer.children[0].source.toLowerCase() === ':file') {
        const uri = vscode.Uri.file(util.from_lisp_string(buffer.children[1]));
        const doc = await vscode.workspace.openTextDocument(uri);
        return new vscode.Location(uri, convertPosition(doc, location.children[2]));
    } else if (buffer.children[0].source.toLowerCase() === ':buffer-and-file') {
        const uri = vscode.Uri.file(util.from_lisp_string(buffer.children[2]));
        const doc = await vscode.workspace.openTextDocument(uri);
        return new vscode.Location(uri, convertPosition(doc, location.children[2]));
    }
}

function kebabToCapitalized(str: string): string {
    return str.toLowerCase()
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

export function convertDescribeSymbol(sexp: any): vscode.MarkdownString | undefined {
    if (util.from_lisp_bool(sexp)) {
        const markdown = new vscode.MarkdownString();
        for (let i = 0; i < sexp.children.length; i += 2) {
            const name = kebabToCapitalized(sexp.children[i].source.slice(1));
            const doc = sexp.children[i + 1].type === 'string' && util.from_lisp_string(sexp.children[i + 1]);
            markdown.appendMarkdown(`**${name}:** ${doc || '*(undocumented)*'}\n\n`);
        }
        return markdown;
    }
}

export function convertInspect (sexp: any): vscode.MarkdownString | undefined {
    if (sexp.type === 'list') {
        const markdown = new vscode.MarkdownString();
        for (const c of sexp.children) {
            if (c.type === 'string') {
                markdown.appendText(util.from_lisp_string(c));
            }
            else if (c.type === 'list') {
                if (c.children[0].source.toLowerCase() === ':newline')
                    markdown.appendText('\n')
                else if (c.children[0].source.toLowerCase() === ':value')
                    // TODO: this does not work:
                    // - paredit parse #<...> into multiple segment
                    // - the value might be a complex S-expr (e.g. a list)
                    markdown.appendMarkdown('`'+c.children[1].source+'`')
            }
        }
        return markdown
    }
}

export function convertIndentSpec(sexp: any): IndentSpec {
    if (sexp.type === 'list') {
        return sexp.children.map(convertIndentSpec);
    } else if (sexp.type === 'number') {
        return Number(sexp.source);
    } else if (sexp.type === 'symbol' && sexp.source.toLowerCase() != 'nil') {
        return sexp.source;
    } else {return 'nil'}
}

export function searchBufferPackage(doc: vscode.TextDocument, pos: vscode.Position): string {
    const regexp = /^[ \t]*\((?:cl:|common-lisp:)?in-package\b[ \t']*(?:[:#])?([^)\s]+)/im;
    for (let i = pos.line; i >= 0; i--) {
        const line = doc.lineAt(i).text;
        const match = line.match(regexp);
        if (match) return match[1].replace(/^"/, '').replace(/"$/, '');
    }
    for (let i = pos.line + 1; i < doc.lineCount; i++) {
        const line = doc.lineAt(i).text;
        const match = line.match(regexp);
        if (match) return match[1].replace(/^"/, '').replace(/"$/, '');
    }
    return 'COMMON-LISP-USER';
}

export function getSymbol(doc: vscode.TextDocument, pos: vscode.Position): string | undefined {
    const range = doc.getWordRangeAtPosition(pos);
    return range && doc.getText(range);
}

export function getExpression(doc: vscode.TextDocument, pos: vscode.Position, direction: 'prev' | 'next', ast?: any): vscode.Range | undefined {
    const offset = doc.offsetAt(pos);
    if (!ast) ast = paredit.parse(doc.getText());
    const nodes = paredit.walk.sexpsAt(ast, offset);
    let node = nodes.filter((n: any) => n.type !== 'toplevel' && n.type !== 'list' && n.type !== 'error' && n.type !== 'comment').pop();
    if (!node) {
        node = (direction === 'prev' ? paredit.walk.prevSexp : paredit.walk.nextSexp)(ast, offset, (n: any) => n.type !== 'comment');
    }
    if (node) return new vscode.Range(doc.positionAt(node.start), doc.positionAt(node.end));
}

export function getTopLevelForm(doc: vscode.TextDocument, pos: vscode.Position, ast?: any): vscode.Range | undefined {
    const offset = doc.offsetAt(pos);
    if (!ast) ast = paredit.parse(doc.getText());
    const node = ast.children.find((child: any) => offset >= child.start && offset <= child.end)
        || ast.children.findLast((child: any) => offset > child.end);
    if (node) return new vscode.Range(doc.positionAt(node.start), doc.positionAt(node.end));
}

export class OliveTextProvider implements vscode.TextDocumentContentProvider {
    static scheme = 'olive-text';
    private static instance: OliveTextProvider;
    private contents = new Map<string, string>();

    private constructor() {
        vscode.workspace.onDidCloseTextDocument(doc => {
            if (doc.uri.scheme === OliveTextProvider.scheme) {
                this.contents.delete(doc.uri.toString());
            }
        });
    }

    public static getInstance(): OliveTextProvider {
        if (!OliveTextProvider.instance) {
            OliveTextProvider.instance = new OliveTextProvider();
        }
        return OliveTextProvider.instance;
    }

    provideTextDocumentContent(uri: vscode.Uri): string | undefined {
        return this.contents.get(uri.toString());
    }

    set(content: string, title: string): vscode.Uri {
        const uuid = crypto.randomUUID();
        const uri = vscode.Uri.from({
            scheme: OliveTextProvider.scheme,
            path: `/${uuid}/${title}`
        });
        this.contents.set(uri.toString(), content);
        return uri;
    }
}
