const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** Exercise the real parser using unsaved documents, without changing fixture files. */
async function withLhatServer(run) {
    const directory = mkdtempSync(path.join(tmpdir(), 'lhat-graph-'));
    const executable = process.env.LHAT_TEST_SERVER || path.resolve(__dirname, '../../lhat/build/debug/lhatls.exe');
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = Buffer.alloc(0), sequence = 0, version = 0;
    const pending = new Map();
    const send = message => {
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
        child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    };
    const rejectAll = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
    child.on('error', rejectAll);
    child.on('exit', code => rejectAll(new Error(`lhatls exited: ${code}`)));
    child.stderr.resume();
    child.stdout.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        while (true) {
            const header = buffer.indexOf('\r\n\r\n');
            if (header < 0) return;
            const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, header).toString())[1]);
            if (buffer.length < header + 4 + length) return;
            const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString());
            buffer = buffer.subarray(header + 4 + length);
            if (message.method && message.id !== undefined) send({ id: message.id, result: null });
            else if (pending.has(message.id)) {
                const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
                if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
            }
        }
    });
    const request = (method, params) => new Promise((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 10000);
        pending.set(id, { resolve, reject, timer }); send({ id, method, params });
    });
    const uri = pathToFileURL(path.join(directory, 'main.lh')).href;
    try {
        await request('initialize', { rootUri: pathToFileURL(directory).href, capabilities: {} });
        send({ method: 'initialized', params: {} });
        const parse = async source => {
            version++;
            send({ method: version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange', params: version === 1
                ? { textDocument: { uri, languageId: 'lhat', version, text: source } }
                : { textDocument: { uri, version }, contentChanges: [{ text: source }] } });
            for (let attempt = 0; attempt < 100; attempt++) {
                const tree = await request('lhat/ast', { textDocument: { uri } });
                if (tree?.source === source) return tree;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error('The checked AST did not catch up with the unsaved document');
        };
        return await run(parse);
    } finally {
        child.kill();
        rejectAll(new Error('Test server closed'));
        rmSync(directory, { recursive: true, force: true });
    }
}
module.exports = { withLhatServer };
