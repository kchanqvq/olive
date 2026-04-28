const paredit = require('paredit.js');

export type IndentSpec = number | string | any[];

// Simple heuristic, only handle standard *READTABLE-CASE*.
// slime-cl-indent eventually calls SWANK:GUESS-PACKAGE for this,
// but heck, SLIME also sucks at general *READTABLE-CASE* anyway!!!
function canonicalizePackage(pkg: string): string {
    if (pkg.startsWith(':')) pkg = pkg.slice(1);
    else if (pkg.startsWith('#:')) pkg = pkg.slice(2);
    else if (pkg.startsWith('"') && pkg.endsWith('"')) pkg = pkg.slice(1, -1);
    return pkg.toUpperCase();
}

// Simple heuristic, only handle standard *READTABLE-CASE*
function parseSymbol(symbol: string, bufferPkg: string): [string, string] {
    const colonPos = symbol.indexOf(':');
    if (colonPos == -1)
        return [symbol, canonicalizePackage(bufferPkg)];
    else if (colonPos == 0)
        return [symbol.slice(1), "KEYWORD"];
    else if (colonPos + 1 < symbol.length && symbol[colonPos + 1] == ':')
        return [symbol.slice(colonPos + 2), symbol.slice(0, colonPos).toUpperCase()];
    else
        return [symbol.slice(colonPos + 1), symbol.slice(0, colonPos).toUpperCase()];
}

type NIndentSpec = number | string | NIndentSpec[];

// Handle some top level special case for indent spec
export function resolveSpec(op: string, bufferPkg: string, systemSpecs: Map<string, Map<string, IndentSpec>>): NIndentSpec | undefined {
    const [symbol, pkg] = parseSymbol(op, bufferPkg);
    let spec = systemSpecs.get(pkg)?.get(symbol) || defaultIndentSpecs[symbol];
    if (!spec) return;
    if (typeof spec == 'number')
        spec = [...Array(spec).fill(4), '&body']
    if (spec == 'defun')
        spec = [4, '&lambda', '&body']
    if (Array.isArray(spec)) {
        if (spec[0] == 'as')
            return resolveSpec(spec[1], bufferPkg, systemSpecs);
        return [0, ...normalizeSpec(spec, bufferPkg, systemSpecs) as NIndentSpec[]];
    }
    return normalizeSpec(spec, bufferPkg, systemSpecs)
}

// Desugar some list indent spec
function normalizeSpec(spec: IndentSpec, bufferPkg: string, systemSpecs: Map<string, Map<string, IndentSpec>>): NIndentSpec {
    if (Array.isArray(spec)) {
        if (spec[spec.length - 1] == '&body') {
            spec = [...spec.slice(0, -1), '&rest', 2];
        }
        return spec.map(s => normalizeSpec(s, bufferPkg, systemSpecs));
    }
    return spec;
}

export function getSubSpec(spec: NIndentSpec, argIdx: number): IndentSpec {
    if (!Array.isArray(spec)) return 'nil';

    let i = spec[0] === '&whole' ? 2 : 0;
    let currIdx = 0;

    for (let j = i; j < spec.length; j++) {
        const s = spec[j];
        if (s === '&rest') return spec[j + 1] === '&lambda' ? 4 : spec[j + 1];
        if (currIdx === argIdx) return s === '&lambda' ? 4 : s;
        currIdx++;
    }
    return spec.at(-1) || 'nil';
}

export function getColumn(text: string, offset: number): number {
    const lastNewline = text.lastIndexOf('\n', offset - 1);
    return offset - (lastNewline + 1);
}

export function getLine(text: string, offset: number): number {
    let line = 0, pos = 0;
    while (true) {
        const next = text.indexOf('\n', pos);
        if (next === -1 || next >= offset) break;
        line++;
        pos = next + 1;
    }
    return line;
}

export function getSpecFromPath(text: string, path: any[], bufferPkg: string, systemSpecs: Map<string, Map<string, IndentSpec>>): NIndentSpec {
    let spec: NIndentSpec = 'nil';
    let parent: any = null;

    for (const node of path) {
        if (!paredit.walk.hasChildren(node) || node.type === 'toplevel') continue;

        const sub: NIndentSpec = parent ? getSubSpec(spec, (parent.children || []).indexOf(node)) : 'nil';

        if (Array.isArray(sub)) {
            spec = sub;
        } else {
            const op = node.children[0];
            const opName = op?.type === 'symbol' 
                ? paredit.walk.source(text, op).toLowerCase()
                : null;
            if (opName) {
                spec = resolveSpec(opName, bufferPkg, systemSpecs) ||
                    (opName?.startsWith('do-')
                        || opName?.startsWith('with-')
                        || opName?.startsWith('without-')) && [0, '&lambda', '&rest', 2]
                    || 'nil';
            }
            else spec = 'nil';
        }
        parent = node;
    }
    return spec;
}

export function computeIndent(
    parentStartCol: number,
    childIdx: number,
    spec: NIndentSpec,
    firstArgCol?: number
): number {
    const sub = getSubSpec(spec, childIdx);
    if (Array.isArray(sub) && sub[0] == '&whole' && typeof sub[1] == 'number')
        return parentStartCol + sub[1];
    if (typeof sub == 'number') return parentStartCol + sub;

    // Default indentation
    if (childIdx === 0) return parentStartCol + 1;
    if (childIdx > 1 && firstArgCol !== undefined) return firstArgCol;
    return parentStartCol + 1;
}

export function getExpectedIndent(text: string, offset: number, bufferPkg: string, systemSpecs: Map<string, Map<string, IndentSpec>>, ast?: any): number {
    if (!ast) ast = paredit.parse(text);

    const path = paredit.walk.containingSexpsAt(ast, offset);
    const node = path.at(-1);

    if (!node || !paredit.walk.hasChildren(node) || node.type === 'toplevel') return 0;

    const children = node.children || [];
    let childIdx = children.findIndex((c: any) => offset <= c.start);
    if (childIdx == -1) childIdx = children.length;

    const parentStart = getColumn(text, node.start);

    const firstArg = children[1];
    const firstArgCol = firstArg && getColumn(text, firstArg.start);

    const spec = getSpecFromPath(text, path, bufferPkg, systemSpecs);

    return computeIndent(parentStart, childIdx, spec, firstArgCol);
}

/*
(labels ((process (l)
                    (etypecase l 
                      (number (format nil "~a" l))
                      (symbol (format nil "'~(~a~)'" l))
                      (list (format nil "[~{~a~^, ~}]" (mapcar #'process l))))))
           (dolist (item '((block 1) ...))
             (format t "'~(~a~)': ~a" (car item) (process (cadr item)))))
 */

export const defaultIndentSpecs: Record<string, IndentSpec> = {
    'block': 1,
    'case': [4, '&rest', ['&whole', 2, '&rest', 1]],
    'ccase': ['as', 'case'],
    'ecase': ['as', 'case'],
    'typecase': ['as', 'case'],
    'etypecase': ['as', 'case'],
    'ctypecase': ['as', 'case'],
    'catch': 1,
    'cond': ['&rest', ['&whole', 2, '&rest', 'nil']],
    'constructor': [4, '&lambda'],
    'defvar': [4, 2, 2],
    'defclass': [6, ['&whole', 4, '&rest', 1], ['&whole', 2, '&rest', 1], ['&whole', 2, '&rest', 1]],
    'defconstant': ['as', 'defvar'],
    'defcustom': [4, 2, 2, 2],
    'define-compiler-macro': ['as', 'defun'],
    'defparameter': ['as', 'defvar'],
    'defconst': ['as', 'defcustom'],
    'define-condition': ['as', 'defclass'],
    'define-modify-macro': [4, '&lambda', '&body'],
    // 'defsetf': 'lisp-indent-defsetf',
    'defsetf': [4, 4, '&body'], // only handle short form for now
    'defun': [4, '&lambda', '&body'],
    'defgeneric': [4, '&lambda', '&body'],
    'define-setf-method': ['as', 'defun'],
    'define-setf-expander': ['as', 'defun'],
    'defmacro': ['as', 'defun'],
    'defsubst': ['as', 'defun'],
    'deftype': ['as', 'defun'],
    // 'defmethod': 'lisp-indent-defmethod',
    'defmethod': ['as', 'defun'],
    'defpackage': [4, 2],
    'defstruct': [['&whole', 4, '&rest', ['&whole', 2, '&rest', 1]], '&rest', ['&whole', 2, '&rest', 1]],
    'destructuring-bind': ['&lambda', 4, '&body'],
    // 'do': 'lisp-indent-do',
    // TODO: tags inside DO
    'do': [['&whole', 'nil', '&rest', 'nil'], ['&whole', 'nil', '&rest', '1'], '&body'],
    'do*': ['as', 'do'],
    'dolist': [['&whole', 4, 2, 1], '&body'],
    'dotimes': ['as', 'dolist'],
    'eval-when': 1,
    'flet': [['&whole', 4, '&rest', ['&whole', 1, 4, '&lambda', '&body']], '&body'],
    'labels': ['as', 'flet'],
    'macrolet': ['as', 'flet'],
    'generic-flet': ['as', 'flet'],
    'generic-labels': ['as', 'flet'],
    'handler-case': [4, '&rest', ['&whole', 2, 2, 4, '&body']],
    'restart-case': ['as', 'handler-case'],
    'if': ['&rest', 'nil'],
    // 'if*': 'common-lisp-indent-if*', // What even is this?
    // 'lambda': ['&lambda', '&rest', 'lisp-indent-function-lambda-hack'],
    'lambda': ['&lambda', '&rest', 2], // for now
    'let': [['&whole', 4, '&rest', ['&whole', 1, 1, 2]], '&body'],
    'let*': ['as', 'let'],
    'compiler-let': ['as', 'let'],
    'handler-bind': ['as', 'let'],
    'restart-bind': ['as', 'let'],
    'locally': 1,
    // 'loop': 'lisp-indent-loop',
    // 'method': 'lisp-indent-defmethod',
    'method': ['as', 'defmethod'],
    'multiple-value-bind': [['&whole', 6, '&rest', 1], 4, '&body'],
    'multiple-value-call': [4, '&body'],
    'multiple-value-prog1': 1,
    'multiple-value-setq': [4, 2],
    'multiple-value-setf': ['as', 'multiple-value-setq'],
    // 'named-lambda': [4, '&lambda', '&rest', 'lisp-indent-function-lambda-hack'],
    'named-lambda': [4, '&lambda', '&rest', 2], // for now
    'pprint-logical-block': [4, 2],
    'print-unreadable-object': [['&whole', 4, 1, '&rest', 1], '&body'],
    // 'prog': ['&lambda', '&rest', 'lisp-indent-tagbody'],
    'prog*': ['as', 'prog'],
    'prog1': 1,
    'prog2': 2,
    'progn': 0,
    'progv': [4, 4, '&body'],
    'return': 0,
    'return-from': ['nil', '&body'],
    'symbol-macrolet': ['as', 'let'],
    // 'tagbody': 'lisp-indent-tagbody',
    'throw': 1,
    'unless': 1,
    'unwind-protect': [5, '&body'],
    'when': 1,
    'with-accessors': ['as', 'multiple-value-bind'],
    'with-compilation-unit': [['&whole', 4, '&rest', 1], '&body'],
    'with-condition-restarts': ['as', 'multiple-value-bind'],
    'with-output-to-string': [4, 2],
    'with-slots': ['as', 'multiple-value-bind'],
    'with-standard-io-syntax': [2],
}
