const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const entry = path.resolve(__dirname, '../src/graphSvg.ts');
const code = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text;
function uri(file, query = '') {
    return { path: file, query, toString: () => `file://${file}${query ? '?' + query : ''}`,
        with: changes => uri(changes.path ?? file, changes.query ?? query) };
}
function host({ destination = uri('/sample.svg'), cancel = false, fail = false } = {}) {
    const writes = [], dialogs = [];
    let active = true;
    const vscode = { l10n: { t: text => text }, window: { showSaveDialog: async options => {
        dialogs.push(options); if (cancel) active = false; return destination;
    } }, workspace: { fs: { writeFile: async (...args) => { if (fail) throw Error('disk full'); writes.push(args); } } } };
    const mod = new Module(entry); mod.require = name => name === 'vscode' ? vscode : require(name); mod._compile(code, entry);
    return { writes, dialogs, save: svg => mod.exports.saveGraphSvg(uri('/sample.lh', 'view=graph'), svg, () => active) };
}
test('SVG export writes UTF-8 only to the destination selected in the save dialog', async () => {
    const h = host(), svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>日本語 &amp; SVG</text></svg>';
    assert.equal((await h.save(svg)).path, '/sample.svg');
    assert.equal(h.dialogs[0].defaultUri.path, '/sample.svg');
    assert.equal(h.dialogs[0].defaultUri.query, '');
    assert.deepEqual(h.dialogs[0].filters, { SVG: ['svg'] });
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0][0].path, '/sample.svg');
    assert.equal(h.writes[0][1].toString('utf8'), svg);
});
test('cancelling, closing the graph, or selecting the source never overwrites it', async () => {
    for (const options of [{ destination: null }, { cancel: true }]) {
        const h = host(options); assert.equal(await h.save('<svg/>'), undefined); assert.equal(h.writes.length, 0);
    }
    const h = host({ destination: uri('/sample.lh') });
    await assert.rejects(h.save('<svg/>'), /\.svg/); assert.equal(h.writes.length, 0);
});
test('export failures propagate to the graph instead of reporting a successful save', async () => {
    await assert.rejects(host({ fail: true }).save('<svg/>'), /disk full/);
});
