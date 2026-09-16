// Vocabulary is data, not individual l10n.t calls. Keep VS Code bundles complete.
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');
const file = path.resolve(__dirname, '../src/webview/vocabulary.ts');
const mod = new Module(file);
mod._compile(buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, file);
for (const [name, column] of [['bundle.l10n.json', 2], ['bundle.l10n.ja.json', 3]]) {
    const target = path.resolve(__dirname, '../l10n', name);
    const bundle = JSON.parse(fs.readFileSync(target, 'utf8'));
    for (const entry of mod.exports.HAT_GROUPS) bundle[entry[2]] = entry[column];
    fs.writeFileSync(target, JSON.stringify(bundle, null, 4) + '\n');
}
