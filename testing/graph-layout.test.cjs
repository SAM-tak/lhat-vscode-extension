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
const { placeComments } = load('../comments.ts');

test('comments occupy independent boxes above their owners without overlapping adjacent code', () => {
    const ast = { kind: 'name', start: 10, end: 11, line: 2, column: 1,
        comments: [{ start: 0, end: 9, block: false }] };
    const owner = { id: 'owner', x: 10, y: 10, width: 30, height: 30, lhat: { ...ast } };
    const next = { id: 'next', x: 10, y: 60, width: 30, height: 30 };
    const right = { id: 'right', x: 60, y: 10, width: 30, height: 30 };
    const graph = { id: 'view', width: 100, height: 100, children: [owner, next, right] };
    placeComments(graph, { source: '# comment\nx', root: ast });
    const comment = graph.children.find(child => child.lhat?.kind === 'comment');
    assert.equal(comment.labels[0].text, 'comment');
    assert.equal(comment.lhat.commentOwner, 'name (2:1)');
    assert.equal(comment.x + comment.width / 2, owner.x + owner.width / 2);
    assert.ok(comment.y + comment.height < owner.y - 18.7, 'the insertion button fits below the comment');
    assert.ok(next.y >= owner.y + owner.height + 20);
    assert.ok(right.x >= comment.x + comment.width + 20);
    assert.equal(comment.lhat.commentAnchor.id, owner.id);
    for (const child of graph.children) {
        assert.ok(child.x + child.width <= graph.width);
        assert.ok(child.y + child.height <= graph.height);
    }
});

test('comment previews and folds preserve the exact source, delimiters, whitespace and spans', () => {
    const source = '# 日本語😀 #tag \r\n#[\r\n\tfirst line\r\n  #[ nested ]#\r\nlast line\r\n]#\r\nx';
    const comments = [{ start: 0, end: source.indexOf('\r\n'), block: false },
        { start: source.indexOf('#['), end: source.lastIndexOf(']#') + 2, block: true }];
    const root = { kind: 'name', start: source.length - 1, end: source.length, line: 8, column: 1, comments };
    const reply = { source, root }, original = JSON.stringify(reply);
    const make = () => ({ id: 'view', width: 100, height: 50, children: [
        { id: 'owner', x: 10, y: 10, width: 80, height: 30, lhat: { ...root } },
    ] });
    const boxes = graph => graph.children.filter(child => child.lhat?.kind === 'comment');
    const key = `comment:${comments[1].start}:${comments[1].end}`;
    for (const scale of [7 / 12, 1, 28 / 12]) {
        const open = boxes(placeComments(make(), reply, { scale, collapse: true }));
        assert.deepEqual(open.map(box => box.labels[0].text), ['日本語😀 #tag', 'first line\n  #[ nested ]#\nlast line']);
        assert(open.every(box => box.lhat.foldable && !box.lhat.collapsed), 'comments start expanded');
        const graph = placeComments(make(), reply, { scale, folds: { [key]: true } });
        const folded = boxes(graph), owner = graph.children.find(child => child.id === 'owner');
        assert.equal(folded[0].lhat.collapsed, false, 'each comment folds independently');
        assert.equal(folded[1].labels[0].text, 'first line…');
        assert(folded[1].height < open[1].height);
        assert(folded[1].y + folded[1].height < owner.y - 18.7 * scale);
        folded.forEach((box, i) => assert.equal(reply.source.slice(box.lhat.start, box.lhat.end),
            source.slice(comments[i].start, comments[i].end)));
        const reopened = boxes(placeComments(make(), reply, { scale, folds: { [key]: false } }));
        assert.deepEqual(reopened, open);
    }
    assert(boxes(placeComments(make(), reply, { collapseAll: true })).every(box => box.lhat.collapsed));
    assert.equal(JSON.stringify(reply), original, 'display and fold operations leave the entire AST and source untouched');
});

test('root and unboxed AST comments remain visible, while folded descendants stay hidden', () => {
    const hidden = { kind: 'param', start: 4, end: 5, line: 2, column: 1,
        comments: [{ start: 0, end: 3, block: false }] };
    const root = { kind: 'func', start: 0, end: 8, line: 1, column: 1, fields: { params: [hidden] },
        comments: [{ start: 0, end: 3, block: false }] };
    const make = collapsed => ({ id: 'view', width: 100, height: 50, children: [
        { id: 'func', x: 10, y: 10, width: 80, height: 30, lhat: { ...root, collapsed } },
    ] });
    const open = placeComments(make(false), { source: '# a\nx   ', root });
    assert.equal(open.children.filter(child => child.lhat?.kind === 'comment').length, 2);
    assert.ok(open.children.some(child => child.lhat?.commentOwner === 'param (2:1)'));
    const folded = placeComments(make(true), { source: '# a\nx   ', root });
    assert.equal(folded.children.filter(child => child.lhat?.kind === 'comment').length, 1);
    const view = { id: 'view', width: 0, height: 0 };
    placeComments(view, { source: '# a\nx   ', root: hidden });
    assert.equal(view.children[0].lhat.kind, 'comment');
    assert.ok(view.height >= view.children[0].height);
});
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
