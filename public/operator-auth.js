(() => {
    'use strict';

    const gateStyle = document.createElement('style');
    gateStyle.textContent = "html.operator-auth-pending body{visibility:hidden}html.operator-auth-pending::after{content:'Checking controller access…';position:fixed;inset:0;z-index:1000;display:grid;place-items:center;background:#000;color:#8a8a8a;font:600 14px/1.4 Inter,system-ui,sans-serif;visibility:visible}";
    document.head.appendChild(gateStyle);

    function safeNext() {
        const here = location.pathname + location.search;
        return here.startsWith('/') && !here.startsWith('//') ? here : '/';
    }

    window.operatorSocket = function operatorSocket() {
        document.documentElement.classList.add('operator-auth-pending');
        const socket = io();
        socket.on('authState', state => {
            if (!state || !state.operator) {
                const next = encodeURIComponent(safeNext());
                location.replace('/pair.html?next=' + next);
                return;
            }
            const needsFirstController = state.localOperator && state.pairedDevices === 0;
            if (needsFirstController && location.pathname !== '/pairing-control.html') {
                const next = encodeURIComponent(safeNext());
                location.replace('/pairing-control.html?first=1&next=' + next);
                return;
            }
            document.documentElement.classList.remove('operator-auth-pending');
        });
        return socket;
    };

    window.operatorFetch = async function operatorFetch(input, init) {
        const response = await fetch(input, init);
        if (response.status === 401) {
            const next = encodeURIComponent(safeNext());
            location.replace('/pair.html?next=' + next);
            throw new Error('This device needs to be paired');
        }
        return response;
    };
})();
