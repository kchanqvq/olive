const vscode = acquireVsCodeApi();

window.addEventListener('message', event => {
    const message = event.data;
    if (message.command === 'setData') {
        render(message.info);
        window.focus();
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

        if (r.cmd === '*ABORT' || r.cmd === 'ABORT' && !hasAbort){
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
        cmd.className = 'cmd';
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
        const div = document.createElement('div');
        div.className = 'frame-item';
        div.textContent = `${f.frame_number}: ${f.description}`;
        framesEl.appendChild(div);
    });
}

// Notify that we are ready
vscode.postMessage({ command: 'ready' });
