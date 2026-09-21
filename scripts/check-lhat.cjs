// Use a rebuilt lhat executable, supplied as an argument or LHAT_RUNTIME.
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const runtime = process.argv[2] || process.env.LHAT_RUNTIME || 'lhat';
// Include local samples too, but leave ignored build products and dependencies out.
const files = [...new Set(execFileSync('git', [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.lh',
], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean))].sort();
assert(files.length > 0, 'No L^ sources found');

function run(args) {
    const result = spawnSync(runtime, ['--language', 'en', ...args], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    if (result.error) throw result.error;
    return result;
}

let failed = false;
for (const file of files) {
    const result = run(['--check', file]);
    if (result.status !== 0) {
        failed = true;
        console.error(`FAIL ${file}\n${result.stdout}${result.stderr}`);
    } else {
        console.log(`PASS ${file}`);
    }
}
assert(!failed, 'L^ type checking failed');

const result = run(['--run', 'testing/zero-based-indices.lh']);
assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
assert.equal(result.stderr, '');
assert.equal(result.stdout.replace(/\r\n/g, '\n'), 'zero-based indices: OK\n');
console.log(`Checked ${files.length} L^ files; zero-based runtime checks passed.`);
