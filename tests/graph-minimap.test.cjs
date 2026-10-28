const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const entry = path.resolve(__dirname, '../src/webview/minimap.ts');
const mod = new Module(entry);
mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
const { DEFAULT_MINIMAP_SIZE, fitMinimapSize, resizeMinimap } = mod.exports;

test('minimap starts at the compact portrait size without enforcing an aspect ratio', () => {
    assert.deepEqual(DEFAULT_MINIMAP_SIZE, { width: 140, height: 220 });
    assert.deepEqual(fitMinimapSize(DEFAULT_MINIMAP_SIZE, { width: 900, height: 600 }), DEFAULT_MINIMAP_SIZE);
    assert.deepEqual(fitMinimapSize({ width: 320, height: 150 }, { width: 900, height: 600 }), { width: 320, height: 150 });
});

test('left and top drags resize only their own axis while keeping bottom/right fixed', () => {
    const bounds = { width: 900, height: 600 };
    const start = { width: 140, height: 220 };
    assert.deepEqual(resizeMinimap(start, 'left', { x: -51, y: -37 }, bounds), { width: 191, height: 220 });
    assert.deepEqual(resizeMinimap(start, 'top', { x: -51, y: -37 }, bounds), { width: 140, height: 257 });
    assert.deepEqual(resizeMinimap(start, 'left', { x: 20, y: 30 }, bounds), { width: 120, height: 220 });
    assert.deepEqual(resizeMinimap(start, 'top', { x: 20, y: 30 }, bounds), { width: 140, height: 190 });
    assert.deepEqual(start, DEFAULT_MINIMAP_SIZE, 'resizing does not mutate the drag-start snapshot');
});

test('top-left drags resize both axes freely and clamp each dimension independently', () => {
    const size = { width: 140, height: 220 }, bounds = { width: 400, height: 300 };
    assert.deepEqual(resizeMinimap(size, 'top-left', { x: -51, y: -37 }, bounds), { width: 191, height: 257 });
    assert.deepEqual(resizeMinimap(size, 'top-left', { x: 20, y: 30 }, bounds), { width: 120, height: 190 });
    assert.deepEqual(resizeMinimap(size, 'top-left', { x: -1000, y: 1000 }, bounds), { width: 400, height: 80 });
    assert.deepEqual(resizeMinimap(size, 'top-left', { x: 1000, y: -1000 }, bounds), { width: 80, height: 300 });
    assert.deepEqual(resizeMinimap(size, 'top-left', { x: 0, y: 0 }, { width: 50, height: 40 }), { width: 50, height: 40 });
    assert.deepEqual(size, DEFAULT_MINIMAP_SIZE);
});

test('minimap resizing cannot invert dimensions or escape the available pane', () => {
    const size = { width: 140, height: 220 }, bounds = { width: 400, height: 300 };
    assert.deepEqual(resizeMinimap(size, 'left', { x: 1000, y: 0 }, bounds), { width: 80, height: 220 });
    assert.deepEqual(resizeMinimap(size, 'top', { x: 0, y: 1000 }, bounds), { width: 140, height: 80 });
    assert.deepEqual(resizeMinimap(size, 'left', { x: -1000, y: 0 }, bounds), { width: 400, height: 220 });
    assert.deepEqual(resizeMinimap(size, 'top', { x: 0, y: -1000 }, bounds), { width: 140, height: 300 });
    assert.deepEqual(fitMinimapSize(size, { width: 50, height: 40 }), { width: 50, height: 40 });
    assert.deepEqual(fitMinimapSize(size, { width: -10, height: 0 }), { width: 0, height: 0 });
});

test('temporary pane clamping preserves a chosen size for when space returns', () => {
    const preferred = { width: 340, height: 420 };
    assert.deepEqual(fitMinimapSize(preferred, { width: 200, height: 180 }), { width: 200, height: 180 });
    assert.deepEqual(fitMinimapSize(preferred, { width: 900, height: 600 }), preferred);
    assert.deepEqual(preferred, { width: 340, height: 420 });
});
