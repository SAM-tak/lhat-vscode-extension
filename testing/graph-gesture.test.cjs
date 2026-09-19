const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const entry = path.resolve(__dirname, '../src/webview/rf/gesture.ts');
const mod = new Module(entry);
mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
const { VERTICAL_DRAG_CONE_DEGREES, dragAxis } = mod.exports;

test('a scrollable node gives only the 30-degree vertical cone to document scrolling', () => {
    assert.equal(VERTICAL_DRAG_CONE_DEGREES, 30);
    assert.equal(dragAxis(0, 10, true), 'vertical');
    assert.equal(dragAxis(1, 2, true), 'vertical');
    assert.equal(dragAxis(-1, -2, true), 'vertical');
    assert.equal(dragAxis(10, 10 * Math.sqrt(3), true), 'vertical');
    assert.equal(dragAxis(10, 10 * Math.sqrt(3) - 0.01, true), 'horizontal');
    assert.equal(dragAxis(1, 1.7, true), 'horizontal');
    assert.equal(dragAxis(-3, 2, true), 'horizontal');
});

test('a node with no horizontal overflow always scrolls the document vertically', () => {
    assert.equal(dragAxis(100, 1, false), 'vertical');
    assert.equal(dragAxis(-100, -1, false), 'vertical');
});
