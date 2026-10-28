const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const entry = path.resolve(__dirname, '../src/webview/rf/gesture.ts');
const mod = new Module(entry);
mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
const { VERTICAL_DRAG_CONE_DEGREES, dragAxis, ownsHorizontalSlide } = mod.exports;

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

test('wide top-level boxes and detached definition values both own horizontal motion', () => {
    assert.equal(ownsHorizontalSlide(false, true, false, true, 400, 600), true,
        'a wide top-level container remains scrollable even when a descendant overrides its subtree');
    assert.equal(ownsHorizontalSlide(true, false, false, true, 400, 600), true,
        'a detached value owns motion inside its subtree');
    assert.equal(ownsHorizontalSlide(false, true, false, true, 600, 400), false,
        'a top-level container that fits sends every drag to document scrolling');
    assert.equal(ownsHorizontalSlide(false, true, true, true, 400, 600), false,
        'an invisible layout wrapper never owns a gesture');
});
