// Small CDP harness for tests that need real browser layout, without a browser
// download. Set LHAT_TEST_BROWSER when Chrome/Edge is not in a standard location.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');
const browserPath = process.env.LHAT_TEST_BROWSER || [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(file => fs.existsSync(file));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function browser(routes, work) {
    assert(browserPath, 'Set LHAT_TEST_BROWSER to Chrome or Edge');
    const server = http.createServer((request, response) => {
        const route = routes[request.url];
        if (!route) { response.writeHead(404); response.end(); return; }
        response.setHeader('Content-Type', route.type); response.end(route.body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lhat-svg-browser-'));
    const child = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let socket, launchError;
    child.on('error', error => { launchError = error; });
    try {
        const portFile = path.join(profile, 'DevToolsActivePort');
        for (let i = 0; !fs.existsSync(portFile) && i < 150 && !launchError; i++) await sleep(100);
        if (launchError) throw launchError;
        const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
        await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
        let sequence = 0;
        const waiting = new Map(), errors = [];
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
            waiting.get(message.id)?.(message); waiting.delete(message.id);
        });
        const call = async (method, params = {}) => {
            const id = ++sequence;
            const reply = await new Promise(resolve => { waiting.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
            assert(!reply.error, JSON.stringify(reply.error)); return reply.result;
        };
        const evaluate = async expression => {
            const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
        };
        const until = async expression => {
            for (let i = 0; i < 100; i++) { if (await evaluate(`Boolean(${expression})`)) return; await sleep(50); }
            throw Error(`Browser condition timed out: ${expression}`);
        };
        await call('Runtime.enable'); await call('Page.enable');
        await call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
        await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
        await work({ evaluate, until, call, errors });
    } finally {
        socket?.close(); child.kill(); server.close();
        // The browser may still hold its profile open on Windows. Keep it in
        // the OS temporary directory; do not race a recursive cleanup.
    }
}
module.exports = { browser, browserPath };
