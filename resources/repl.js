const vscode = acquireVsCodeApi();
const content = document.getElementById('content');
const completionList = document.getElementById('completion-list');

let currentInput = undefined, completions = [], selectedIndex = -1;
let lastRequestId = 0, isReading = false;

// Default settings (will be overridden by VS Code)
let settings = { minWordLength: 3, delay: 10 };

window.onclick = () => currentInput?.focus();
window.onfocus = () => currentInput?.focus();
window.onkeydown = e => {
    if (e.ctrlKey && e.key === 'c' && !window.getSelection().toString()) {
        vscode.postMessage({ command: 'interrupt' });
    }
};

window.onmessage = e => {
    const m = e.data;
    switch (m.command) {
        case 'addOutput': appendOutput(m.text, m.type || 'output', m.throttle); break;
        case 'prompt':    createNewInput(m.package, false); break;
        case 'setPrompt': setLastPrompt(m.package); break;
        case 'read':      createNewInput('', true); break;
        case 'autocompleteResults': showCompletions(m.completions, m.requestId); break;
        case 'settings':  settings = m; break;
        case 'flush': flushOutput(); break;
        case 'indent': addIndent(m.value, m.offset, m.newline); break;
        case 'disconnect':
            if (currentInput) currentInput.disabled = true;
            break;
    }
};

function setLastPrompt(pkg) {
    const lastPrompt = content.querySelector('.line:last-child .prompt .pkg');
    if (lastPrompt) {
        lastPrompt.textContent = pkg;
    }
}

function appendOutput(text, type, throttle) {
    const activeLine = currentInput && !currentInput.disabled && currentInput.parentElement;
    const last = (activeLine ? activeLine.previousElementSibling : content.lastElementChild);

    if (last && last.classList.contains(type) && !last.classList.contains('line')) {
        last.textContent += text;
    } else {
        const div = document.createElement('div');
        div.className = type;
        div.textContent = text;
        if (activeLine) {
            content.insertBefore(div, activeLine);
        } else {
            content.appendChild(div);
        }
    }
    content.scrollTop = content.scrollHeight;
    if (throttle)
        vscode.postMessage({ command: 'unthrottle' });
}

function addIndent(value, offset, newline) {
    if (currentInput && !currentInput.disabled) {
        if (newline) offset ++;
        currentInput.setRangeText(' '.repeat(value), offset, offset,
            (currentInput.selectionStart == offset)? 'end' : 'preserve');
    }
}

function flushOutput() {
    const activeLine = currentInput && !currentInput.disabled && currentInput.parentElement;
    content.innerHTML = '';
    if (activeLine) {
        content.appendChild(activeLine);
        currentInput.focus();
    }
    else {
        currentInput = undefined;
    }
}

function createNewInput(pkg, readMode) {
    if (currentInput) currentInput.disabled = true;

    isReading = readMode;
    const line = document.createElement('div');
    line.className = 'line';

    if (!readMode) {
        const prompt = document.createElement('div');
        prompt.className = 'prompt';
        prompt.innerHTML = `<span class="pkg">${pkg}</span>> `;
        line.appendChild(prompt);
    }

    currentInput = document.createElement('textarea');
    currentInput.className = 'input';
    currentInput.rows = 1;
    currentInput.onkeydown = handleKeyDown;
    currentInput.oninput = handleOnInput;

    line.appendChild(currentInput);
    content.appendChild(line);
    currentInput.focus();
    content.scrollTop = content.scrollHeight;
}

function handleKeyDown(e) {
    if (completionList.style.display === 'flex') {
        if (e.key === 'ArrowDown') return e.preventDefault(), selectedIndex = (selectedIndex + 1) % completions.length, updateSelection();
        if (e.key === 'ArrowUp')   return e.preventDefault(), selectedIndex = (selectedIndex - 1 + completions.length) % completions.length, updateSelection();
        if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), applyCompletion(completions[selectedIndex]);
        if (e.key === 'Escape')    return hideCompletions();
    }

    if (e.key === 'Enter' && !e.shiftKey) {
        const text = currentInput.value;
        if (isReading || isBalanced(text)) {
            e.preventDefault();
            currentInput.disabled = true;
            vscode.postMessage({ command: isReading ? 'readSubmit' : 'eval', text });
        } else if (!isReading) {
            vscode.postMessage({ command: 'computeIndent',
                text, offset: currentInput.selectionStart, newline: true});
        }
    } else if (e.key === 'Tab') {
        e.preventDefault();
        triggerAutocomplete(true); // Force on Tab
    }
}

function handleOnInput() {
    currentInput.style.height = 'auto';
    currentInput.style.height = currentInput.scrollHeight + 'px';
    clearTimeout(window.autoTimeout);
    window.autoTimeout = setTimeout(() => triggerAutocomplete(false), settings.delay);
}

function triggerAutocomplete(force) {
    if (isReading) return;
    const text = currentInput.value.slice(0, currentInput.selectionStart);
    const m = text.match(/([^\s()\"#;,`']+)$/);

    if (m && (force || m[1].length >= settings.minWordLength)) {
        vscode.postMessage({ command: 'autocomplete', text: m[1], requestId: ++lastRequestId });
    } else {
        hideCompletions();
    }
}

function showCompletions(items, reqId) {
    if (reqId !== lastRequestId) return;
    completions = items;
    if (!items.length) return hideCompletions();

    completionList.innerHTML = '';
    items.forEach((it, i) => {
        const d = document.createElement('div');
        d.className = 'item';
        d.textContent = it;
        d.onclick = () => applyCompletion(it);
        completionList.appendChild(d);
    });

    completionList.style.display = 'flex';
    selectedIndex = 0;
    updateSelection();

    const rect = currentInput.getBoundingClientRect();
    completionList.style.top = (rect.bottom + 5) + 'px';
    completionList.style.left = rect.left + 'px';
}

function updateSelection() {
    Array.from(completionList.children).forEach((c, i) => c.classList.toggle('selected', i === selectedIndex));
}

function applyCompletion(it) {
    const text = currentInput.value, cursor = currentInput.selectionStart;
    const before = text.slice(0, cursor), m = before.match(/([^\s()\"#;,`']+)$/);
    if (m) {
        const after = text.slice(cursor), newBefore = before.slice(0, -m[1].length) + it;
        currentInput.value = newBefore + after;
        currentInput.selectionStart = currentInput.selectionEnd = newBefore.length;
    }
    hideCompletions();
    currentInput.focus();
}

function hideCompletions() {
    completionList.style.display = 'none';
    completions = [];
    selectedIndex = -1;
}

function isBalanced(text) {
    let stringp = false, comments = false, depth = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (comments) { if (c === '\n') comments = false; }
        else if (stringp) {
            if (c == '\\') i++;
            else if (c == '"') { stringp = false; depth--; }
        } else {
            switch (c) {
                case ';': comments = true; break;
                case '\\': i++; break;
                case '(': depth++; break;
                case ')': depth--; break;
                case '"': depth++; stringp = true; break;
            }
        }
    }
    return depth <= 0 && !stringp;
}

vscode.postMessage({ command: 'ready' });
