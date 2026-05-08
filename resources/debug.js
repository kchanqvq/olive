import '@vscode/codicons/dist/codicon.css';
import './debug.css';
const vscode = acquireVsCodeApi();

window.addEventListener('message', event => {
    const m = event.data;
    switch (m.command) {
        case 'setData': render(m.info); window.focus(); break;
        case 'frameLocals': renderFrameLocals(m.index, m.locals, m.catchTags); break;
    }
});

window.addEventListener('keydown', event => {
    if (event.key === 'a') {
        vscode.postMessage({ command: 'invokeAbort' });
    } else if (event.key === 'c') {
        vscode.postMessage({ command: 'invokeContinue' });
    } else if (event.key >= '0' && event.key <= '9') {
        vscode.postMessage({ command: 'invokeRestart', index: parseInt(event.key) });
    }
});

function render(info) {
    document.getElementById('debug-title').textContent = info.title;
    
    const restartsEl = document.getElementById('restarts');
    restartsEl.innerHTML = '';
    
    const table = document.createElement('table');
    table.className = 'restarts-table';

    var hasAbort, hasContinue;
    info.restarts.forEach((r, i) => {
        const tr = document.createElement('tr');
        tr.onclick = () => vscode.postMessage({ 
            command: 'invokeRestart', 
            index: i 
        });

        const tdKbd = document.createElement('td');
        tdKbd.className = 'restart-kbd';

        if ((r.cmd === '*ABORT' || r.cmd === 'ABORT') && !hasAbort){
            const kbd = document.createElement('kbd');
            kbd.textContent = 'A';
            hasAbort = true;
            tdKbd.appendChild(kbd);
        }
        else if(r.cmd === 'CONTINUE' && !hasContinue){
            const kbd = document.createElement('kbd');
            kbd.textContent = 'C';
            hasContinue = true;
            tdKbd.appendChild(kbd);
        }
        else {
            tdKbd.textContent = String(i);
        }
        tr.appendChild(tdKbd);

        const cmd = document.createElement('span');
        cmd.className = 'restart-cmd';
        cmd.textContent = r.cmd;

        const tdDesc = document.createElement('td');
        tdDesc.className = 'restart-desc';
        tdDesc.append(cmd, r.description);
        tr.appendChild(tdDesc);

        table.appendChild(tr);
    });
    restartsEl.appendChild(table);

    const framesEl = document.getElementById('frames');
    framesEl.innerHTML = '';
    info.stack_frames.forEach(f => {
        const details = document.createElement('details');
        details.className = 'frame-container';
        details.id = `frame-${f.frame_number}`;

        const summary = document.createElement('summary');
        summary.className = 'frame-header';
        
        const icon = document.createElement('span');
        icon.className = 'codicon codicon-chevron-right';
        
        const title = document.createElement('span');
        title.className = 'frame-title';
        title.textContent = f.description;

        summary.append(icon, title);

        const frameActions = document.createElement('div');
        frameActions.className = 'frame-actions';

        const printButton = function (legend, title, cmd) {
            const btn = document.createElement('span');
            btn.className = 'action-button';
            btn.textContent = legend;
            btn.title = title;
            btn.onclick = (e) => {
                e.stopPropagation();
                vscode.postMessage({ command: cmd, index: f.frame_number });
            };
            frameActions.appendChild(btn);
        }

        printButton('Disassemble', 'Disassemble the code for the frame', 'disassembleFrame');
        printButton('Evaluate...', 'Evaluate form in the frame', 'evalInFrame');

        if (f.restartable) {
            const restartIndicator = document.createElement('span');
            restartIndicator.className = 'codicon codicon-debug-restart indicator';
            restartIndicator.title = 'Restartable';
            summary.appendChild(restartIndicator);

            printButton('Restart', 'Restart execution of the frame', 'restartFrame');
            printButton('Return...', 'Return value from the frame', 'returnFromFrame');
        }

        const frameLocals = document.createElement('div');
        frameLocals.className = 'frame-locals';
        const dummy = document.createElement('div');
        dummy.className = 'local';
        dummy.textContent = 'Loading...'
        frameLocals.appendChild(dummy);

        const frameCatchTags = document.createElement('div');
        frameCatchTags.className = 'frame-catch-tags';

        summary.onclick = (e) => {
            e.preventDefault();

            document.querySelectorAll('.frame-container').forEach(d => {
                d.open = false;
            });

            if (!details.open) {
                details.open = true;
                vscode.postMessage({ command: 'goToSource', index: f.frame_number });
                if (!details.hasAttribute('data-loaded')) {
                    vscode.postMessage({ command: 'getFrameLocals', index: f.frame_number });
                }
            }
        };

        details.appendChild(summary);
        details.appendChild(frameActions);
        details.appendChild(frameLocals);
        details.appendChild(frameCatchTags);
        framesEl.appendChild(details);
    });
}

function renderFrameLocals(index, locals, catchTags) {
    const details = document.getElementById(`frame-${index}`);
    details.setAttribute('data-loaded', 'true');

    const frameLocals = details.querySelector(`.frame-locals`);
    frameLocals.innerHTML = '';
    if (locals.length === 0) {
        const dummy = document.createElement('div');
        dummy.className = 'local';
        dummy.textContent = '(no locals)'
        frameLocals.appendChild(dummy);
    }

    locals.forEach(l => {
        const name = document.createElement('span');
        name.className = 'local-name';
        name.textContent = l.name;

        const local = document.createElement('div');
        local.className = 'local';
        local.append(name, l.value);

        frameLocals.appendChild(local);
    });

    const frameCatchTags = details.querySelector(`.frame-catch-tags`);
    catchTags.forEach(t => {
        const tag = document.createElement('span');
        tag.className = 'catch-tag';
        tag.textContent = t;
        frameCatchTags.appendChild(tag);
    })
}

// Notify that we are ready
vscode.postMessage({ command: 'ready' });
