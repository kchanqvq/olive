import * as indent from '../indent';

function assertEq(actual: any, expected: any, msg: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        console.error(`FAIL: ${msg}`);
        console.error(`  Expected: ${JSON.stringify(expected)}`);
        console.error(`  Actual:   ${JSON.stringify(actual)}`);
    } else {
        console.log(`PASS: ${msg}`);
    }
}

const customSpecs = new Map<string, Map<string, indent.IndentSpec>>();

// Helper for end-to-end testing
function testIndent(textWithCursor: string, expected: number, msg: string) {
    const offset = textWithCursor.indexOf('|');
    const text = textWithCursor.replace('|', '');
    const actual = indent.getExpectedIndent(text, offset, 'COMMON-LISP-USER', customSpecs);
    assertEq(actual, expected, msg);
    const actual1 = indent.getExpectedIndent(text.slice(0,-1), offset, 'COMMON-LISP-USER', customSpecs);
    assertEq(actual1, expected, msg+' -unbalanced');
    const actual2 = indent.getExpectedIndent(text+')', offset, 'COMMON-LISP-USER', customSpecs);
    assertEq(actual2, expected, msg + ' +unbalanced');
}

// Basic function call
testIndent('(foo |)', 1, 'Simple call: after space (default indent)');
testIndent('(foo\n|)', 1, 'Simple call: next line');
testIndent('(foo a\n|)', 5, 'Simple call: after arg (align with a)');
testIndent('(foo\n  a\n|)', 2, 'Simple call: after arg on new line (indent 2)');

// Let forms
testIndent('(let |)', 4, 'let: at bindings pos (spec 4)');
testIndent('(let\n|)', 4, 'let: bindings line');
testIndent('(let ((x 1))\n|)', 2, 'let: body line');
testIndent('(let ((x 1)\n|))', 6, 'let: second binding (align with first)');

// If forms
testIndent('(if |)', 1, 'if: test');
testIndent('(if a\n|)', 4, 'if: then');
testIndent('(if a\n    b\n|)', 4, 'if: else');

// Case forms
testIndent('(case x\n|)', 2, 'case: first clause');
testIndent('(case x\n  (1 |))', 3, 'case: inside clause after key');
testIndent('(case x\n  (1 2)\n|)', 2, 'case: second clause');

// Cond forms
testIndent('(cond |)', 2, 'cond: first clause');
testIndent('(cond ((= x 1) |))', 7, 'cond: inside clause after test');
testIndent('(cond ((= x 1)\n|))', 7, 'cond: inside clause after test new line');

// Defun forms
testIndent('(defun |)', 4, 'defun: name');
testIndent('(defun f |)', 4, 'defun: args');
testIndent('(defun f (x)\n|)', 2, 'defun: body');

// Labels/Flet
testIndent('(labels (|))', 9, 'labels: first definition');
testIndent('(labels (()|))', 9, 'labels: second definition');
testIndent('(labels (()\n|))', 9, 'labels: second definition new line');
testIndent('(labels ((f (x)\n|)))', 11, 'labels: inside definition body');

// Multiple-value-bind
testIndent('(multiple-value-bind |)', 6, 'mv-bind: vars');
testIndent('(multiple-value-bind (x y) |)', 4, 'mv-bind: value-form');
testIndent('(multiple-value-bind (x y) z\n|)', 2, 'mv-bind: body');

// Unwind-protect
testIndent('(unwind-protect |)', 5, 'unwind-protect: protected-form');
testIndent('(unwind-protect x\n|)', 2, 'unwind-protect: cleanup-form');

// Nested forms
testIndent('(let ((x 1))\n  (if x\n|))', 6, 'Nested if inside let');
testIndent('(defun f (x)\n  (let ((y 1))\n|))', 4, 'Nested let inside defun');

// &lambda tests
testIndent('(lambda |)', 4, 'lambda: args (spec &lambda)');
testIndent('(lambda (x)\n|)', 2, 'lambda: body');

// &whole tests
testIndent('(dolist |)', 4, 'dolist: bindings (spec &whole 4)');
testIndent('(dolist (x list)\n|)', 2, 'dolist: body (spec &body)');

// Custom spec test
customSpecs.set('COMMON-LISP-USER', new Map())
customSpecs.get('COMMON-LISP-USER')?.set('my-macro', [4, 4, '&body']);
testIndent('(my-macro |)', 4, 'custom: arg1');
testIndent('(my-macro a |)', 4, 'custom: arg2');
testIndent('(my-macro a b\n|)', 2, 'custom: body');

// Defvar forms
testIndent('(defvar |)', 4, 'defvar: name');
testIndent('(defvar *x* |)', 2, 'defvar: value');
testIndent('(defvar *x* 1\n|)', 2, 'defvar: docstring');

// Defclass forms
testIndent('(defclass |)', 6, 'defclass: name');
testIndent('(defclass c (|))', 13, 'defclass: supers');
testIndent('(defclass c ()\n  (|))', 3, 'defclass: slot');

// Defstruct forms
testIndent('(defstruct |)', 4, 'defstruct: name/options');
testIndent('(defstruct s\n|)', 2, 'defstruct: slot');

// Flet forms
testIndent('(flet ((f (x) |)))', 9, 'flet: inside definition body');
testIndent('(flet ((f (x) x))\n|)', 2, 'flet: body');

// Handler-case
testIndent('(handler-case |)', 4, 'handler-case: form');
testIndent('(handler-case x\n|)', 2, 'handler-case: clause');
testIndent('(handler-case x\n  (error (e)\n|))', 4, 'handler-case: inside clause body');

// Progn/Prog1/Prog2
testIndent('(progn\n|)', 2, 'progn: first form');
testIndent('(prog1\n|)', 4, 'prog1: first form');
testIndent('(prog2\n|)', 4, 'prog2: first form');

// With-slots
testIndent('(with-slots (a b) x\n|)', 2, 'with-slots: body');

// Default alignment (no spec)
testIndent('(list |)', 1, 'default: after op');
testIndent('(list\n|)', 1, 'default: next line');
testIndent('(list a\n|)', 6, 'default: align with first arg');
testIndent('(list a\n      b\n|)', 6, 'default: align with first arg (multi)');

// Comments and whitespace
testIndent('(let ((x 1)) ; comment\n|)', 2, 'let: body after comment');
testIndent('(defun f (x)\n  "doc"\n|)', 2, 'defun: body after docstring');
testIndent('(defun f ()\n  ; line comment\n  |)', 2, 'After line comment');
testIndent('(defun f ()\n  "multiline\n   string"\n  |)', 2, 'After multiline string');
testIndent('(list "one" ; comment\n      |)', 6, 'Align after string and comment');
testIndent('(list "one"\n      "two"\n      |)', 6, 'Align with string args');
testIndent('(let ((x "val"))\n  ; comment\n  (foo\n   |))', 3, 'Inside nested form after comment');
testIndent('(\"|")', 0, 'Inside empty string at start of list');
testIndent('(defun f ()\n  \"line 1\n   line 2\"\n  |)', 2, 'After multiline string with leading spaces');
testIndent('(list \"a\"\n      ; comment\n      |)', 6, 'Align after string and comment line');

// Inside string
testIndent('\"foo|\"', 0, 'Inside string at top level');
testIndent('\"foo\n|\"', 0, 'Inside multiline string at top level');
testIndent('(list \"foo|\")', 0, 'Inside string in list');
testIndent('(list \"foo\n|\")', 0, 'Inside multiline string in list');
testIndent('(defun f ()\n  \"docstring|\")', 0, 'Inside docstring');
testIndent('(defun f ()\n  \"docstring\n|\")', 0, 'Inside multiline docstring');
