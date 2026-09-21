const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load(file) {
    const entry = path.resolve(__dirname, '../src/webview/rf', file);
    const mod = new Module(entry);
    mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
    return mod.exports;
}
const { changedHandles } = load('handleUpdates.ts');
const { LayoutClient } = load('layoutClient.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
function engine() {
    const jobs = [];
    return { jobs, disposed: 0,
        layout(reply, options) { const job = { reply, options, ...deferred() }; jobs.push(job); return job.promise; },
        dispose() { this.disposed++; },
    };
}
const result = id => ({ graph: { id }, elapsed: 20 });

test('mounting a large graph relies on the shared resize observer, without per-node forced updates', () => {
    const nodes = Array.from({ length: 1700 }, (_, i) => ({ id: `node${i}`, data: { flowHandleX: 40, definitionHandleY: 20 } }));
    const mounted = changedHandles(nodes, new Map());
    assert.deepEqual(mounted.changed, []);
    assert.equal(mounted.geometry.size, 1700);
    assert.deepEqual(changedHandles(nodes.map(n => ({ ...n, position: { x: 200, y: 400 } })), mounted.geometry).changed, [],
        'moving the graph does not require new relative port measurements');
    nodes[20].data.flowHandleX = 90;
    nodes[120].data.definitionHandleY = 35;
    const moved = changedHandles(nodes, mounted.geometry);
    assert.deepEqual(moved.changed, ['node20', 'node120'], 'all changed ports can be updated in one batch');
    assert.deepEqual(changedHandles(nodes, moved.geometry).changed, []);
});

test('folding removes stale port geometry, while changing port kinds updates existing nodes', () => {
    const node = { id: 'box', data: { definitionRole: 'value', noExecutionHandles: true } };
    const mounted = changedHandles([node], new Map());
    assert.deepEqual(changedHandles([{ ...node, data: { ...node.data, noExecutionHandles: false } }], mounted.geometry).changed, ['box']);
    const folded = changedHandles([], mounted.geometry);
    assert.equal(folded.geometry.size, 0);
    assert.deepEqual(changedHandles([node], folded.geometry).changed, []);
});

test('rapid edits and resizes keep only the active layout and the latest pending snapshot', async () => {
    const worker = engine(), client = new LayoutClient(async () => worker);
    const first = client.layout('first', { width: 400 }); await tick();
    const middle = client.layout('middle', { width: 500 });
    const latest = client.layout('latest', { width: 600 });
    assert.equal(await middle.promise, undefined);
    assert.equal(worker.jobs.length, 1);
    worker.jobs[0].resolve(result('first'));
    assert.deepEqual(await first.promise, result('first')); await tick();
    assert.equal(worker.jobs.length, 2);
    assert.equal(worker.jobs[1].reply, 'latest');
    assert.deepEqual(worker.jobs[1].options, { width: 600 });
    worker.jobs[1].resolve(result('latest'));
    assert.deepEqual(await latest.promise, result('latest'));
    client.dispose();
});

test('cancelling obsolete views suppresses their result and skips cancelled pending layouts', async () => {
    const worker = engine(), client = new LayoutClient(async () => worker);
    const old = client.layout('old', {}); await tick(); old.cancel();
    const pending = client.layout('cancelled', {}); pending.cancel();
    assert.equal(await old.promise, undefined); assert.equal(await pending.promise, undefined);
    worker.jobs[0].resolve(result('old')); await tick();
    assert.equal(worker.jobs.length, 1);
    const current = client.layout('current', {}); await tick();
    worker.jobs[1].resolve(result('current'));
    assert.deepEqual(await current.promise, result('current'));
    client.dispose();
});

test('worker startup also coalesces requests and disposal prevents delayed initialization from running a layout', async () => {
    const startup = deferred(), worker = engine(), client = new LayoutClient(() => startup.promise);
    const old = client.layout('old', {}), latest = client.layout('latest', {});
    assert.equal(await old.promise, undefined);
    client.dispose(); startup.resolve(worker); await tick();
    assert.equal(await latest.promise, undefined);
    assert.equal(worker.jobs.length, 0); assert.equal(worker.disposed, 1);
    assert.equal(await client.layout('closed', {}).promise, undefined);
});

test('closing a view resolves active and queued requests without waiting for expensive work', async () => {
    const worker = engine(), client = new LayoutClient(async () => worker);
    const current = client.layout('current', {}); await tick();
    const pending = client.layout('pending', {});
    client.dispose(); await tick();
    assert.equal(await current.promise, undefined); assert.equal(await pending.promise, undefined);
    assert.equal(worker.disposed, 1);
    worker.jobs[0].resolve(result('late')); await tick();
    assert.equal(worker.jobs.length, 1);
});

test('a failed worker reports the error and the latest queued view retries with a new worker', async () => {
    const workers = [engine(), engine()]; let creates = 0;
    const client = new LayoutClient(async () => workers[creates++]);
    const failed = client.layout('bad', {}); await tick();
    const pending = client.layout('latest', {});
    const rejected = assert.rejects(failed.promise, /worker failed/);
    workers[0].jobs[0].reject(new Error('worker failed')); await rejected; await tick();
    assert.equal(workers[0].disposed, 1); assert.equal(creates, 2);
    assert.equal(workers[1].jobs[0].reply, 'latest');
    workers[1].jobs[0].resolve(result('latest'));
    assert.deepEqual(await pending.promise, result('latest'));
    client.dispose();
});

test('worker startup failure is reported, and a subsequent request can retry', async () => {
    const worker = engine(); let creates = 0;
    const client = new LayoutClient(async () => { if (!creates++) throw new Error('fetch failed'); return worker; });
    await assert.rejects(client.layout('bad', {}).promise, /fetch failed/);
    const next = client.layout('retry', {}); await tick();
    worker.jobs[0].resolve(result('retry'));
    assert.deepEqual(await next.promise, result('retry'));
    client.dispose();
});
