// Vocabulary is data, not individual l10n.t calls. Keep VS Code bundles complete.
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');
const load = file => {
    const loaded = new Module(file);
    loaded._compile(buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, file);
    return loaded;
};
const file = path.resolve(__dirname, '../src/webview/vocabulary.ts');
const mod = new Module(file);
mod._compile(buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, file);
const statementsFile = path.resolve(__dirname, '../src/graphStatements.ts');
const statements = new Module(statementsFile);
statements._compile(buildSync({ entryPoints: [statementsFile], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, statementsFile);
for (const [name, column] of [['bundle.l10n.json', 2], ['bundle.l10n.ja.json', 3]]) {
    const target = path.resolve(__dirname, '../l10n', name);
    const bundle = JSON.parse(fs.readFileSync(target, 'utf8'));
    for (const entry of mod.exports.HAT_GROUPS) bundle[entry[2]] = entry[column];
    const assignments = load(path.resolve(__dirname, '../src/graphAssignments.ts'));
    for (const label of Object.values(assignments.exports.ASSIGNMENT_LABELS)) bundle[label] ??= label;
    for (const label of Object.values(statements.exports.STATEMENT_TEMPLATE_LABELS)) bundle[label] ??= label;
    const lists = load(path.resolve(__dirname, '../src/graphLists.ts'));
    for (const label of Object.values(lists.exports.LIST_TEMPLATE_LABELS)) bundle[label] ??= label;
    fs.writeFileSync(target, JSON.stringify(bundle, null, 4) + '\n');
}
