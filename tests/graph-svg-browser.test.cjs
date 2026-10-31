const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { browser } = require('./browser.cjs');
const ja = require('../l10n/bundle.l10n.ja.json');
const { branchedCalls } = require('./call-tree-fixture.cjs');
const { conditionalExpressions, branchFlow, terminalFlow } = require('./condition-fixture.cjs');
const { patternMatching } = require('./pattern-fixture.cjs');
const { assignment } = require('./assignment-fixture.cjs');
const { catchFlow } = require('./catch-fixture.cjs');
const { operatorExpression } = require('./operator-fixture.cjs');
const { methodCall, boundSlice } = require('./method-fixture.cjs');
const { indexExpression } = require('./index-fixture.cjs');
const { interpolation, nestedInterpolation } = require('./interpolation-fixture.cjs');

const source = 'let^route = f^req:string^ { return^ 1, req }\nlet^a, b = route("Hello & <SVG>")\nlet^nested = {2, 3}\nlet^last = "日本語 & <text>"';
const n = (kind, text, fields, from = 0, extra = {}) => {
    const start = source.indexOf(text, from); assert(start >= 0, text);
    return { kind, start, end: start + text.length, line: 1, column: start + 1, fields, ...extra };
};
const ident = (text, from = 0, inferredType) => n('ident', text, undefined, from, { inferredType });
const number = value => n('int', String(value), undefined, 0, { inferredType: 'number^' });
const string = value => n('string', JSON.stringify(value), undefined, 0, { inferredType: 'string^' });
const returned = n('return', 'return^ 1, req', { values: [number(1), ident('req', source.indexOf('return^'), 'string^')] });
const fn = n('func', 'f^req:string^ { return^ 1, req }', {
    params: [n('param', 'req:string^', { name: ident('req'), type: n('type-name', 'string^') }, 0, { inferredType: 'string^' })],
    body: n('block', '{ return^ 1, req }', { items: [returned] }),
}, 0, { inferredReturnType: '(number^, string^)' });
const root = n('block', source, { items: [
    n('define', source.split('\n')[0], { targets: [ident('route', 0, 'f^string^ -> number^, string^;')], values: [fn] }),
    n('define', source.split('\n')[1], { targets: [ident('a', source.indexOf('let^a'), 'number^'), ident('b', source.indexOf('let^a'), 'string^')], values: [
        n('call', 'route("Hello & <SVG>")', { target: ident('route', source.indexOf('let^a')), args: [string('Hello & <SVG>')] }, 0,
            { callable: { inputs: [{ name: 'req', type: 'string^' }], outputs: ['number^', 'string^'] } }),
    ] }),
    n('define', source.split('\n')[2], { targets: [ident('nested')], values: [n('table', '{2, 3}', { items: [number(2), number(3)] })] }),
    n('define', source.split('\n')[3], { targets: [ident('last', 0, 'string^')], values: [string('日本語 & <text>')] }),
] });
const html = (reply, acknowledgeEdits = true) => `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'nonce-test'; connect-src 'self'; worker-src blob:;"><style>:root {
--vscode-editor-background:#111314;--vscode-editor-foreground:#ddd;--vscode-editor-font-family:Consolas,monospace;
--vscode-editorWidget-background:#222;--vscode-editorWidget-border:#333;--vscode-input-background:#151718;
--vscode-input-foreground:#ddd;--vscode-focusBorder:#58a;--vscode-descriptionForeground:#999;
}</style><link rel="stylesheet" href="/graph.css"><link rel="stylesheet" href="/bundle.css"><div id="root" data-layout-worker="/layout-worker.js"></div><script nonce="test">
window.exports=[];window.edits=[];window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(m){
if(m.type==='chooseType'||m.type==='applyType'||m.type==='removeType'||m.type==='rename'||m.type==='insertElement'||m.type==='replaceOperator'||m.type==='editTextField'||m.type==='editComment'||m.type==='toggleStatement'||m.type==='insertStatement'||m.type==='editStructure'||m.type==='deleteElement'||m.type==='replaceExpression'||m.type==='editLiteral'||m.type==='editInterpolation'||m.type==='editAnnotation'){window.edits.push(m);${acknowledgeEdits ? "window.postMessage({type:'statementResult',id:m.id},'*');" : ''}}
if(m.type==='saveSvg'){window.exports.push(m);window.postMessage({type:'svgResult',id:m.id},'*');}
if(m.type==='ready'){window.postMessage({type:'localization',language:'ja',bundle:${JSON.stringify(ja)}},'*');window.postMessage({type:'tree',reply:${JSON.stringify(reply)},uri:'file:///svg-example.lh',version:1},'*');}
}});</script><script nonce="test" src="/bundle.js"></script>`;
const routes = { '/': { type: 'text/html', body: html({source,root}) } };
for (const [url, file, type] of [['/graph.css', 'media/graph.css', 'text/css'], ['/bundle.css', 'media/rf/bundle.css', 'text/css'], ['/bundle.js', 'media/rf/bundle.js', 'text/javascript'], ['/layout-worker.js', 'media/rf/layout-worker.js', 'text/javascript']]) {
    routes[url] = { type, body: fs.readFileSync(path.resolve(__dirname, '..', file)) };
}
async function svgTexts({ evaluate, until }) {
    await until(`document.querySelector('.svg-export>button') && !document.querySelector('.svg-export>button').disabled`);
    const count = await evaluate('window.exports.length');
    await evaluate(`document.querySelector('.svg-export>button').click()`);
    await until(`document.querySelector('.svg-export-menu>button')`);
    await evaluate(`document.querySelector('.svg-export-menu>button').click()`);
    await until(`window.exports.length===${count + 1}`);
    const result = await evaluate(`(()=>{const doc=new DOMParser().parseFromString(window.exports.at(-1).svg,'image/svg+xml');return {error:doc.querySelector('parsererror')?.textContent,text:[...doc.querySelectorAll('text')].map(t=>t.textContent)}})()`);
    assert(!result.error, result.error); return result.text;
}

const graphReady = `document.querySelector('.svg-export>button') && !document.querySelector('.svg-export>button').disabled`;
async function graphToolbar({ evaluate, until }, label) {
    await until(graphReady);
    await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent===${JSON.stringify(label)})?.click()`);
    await until(graphReady);
}
async function saveSemanticSvg({ evaluate }, name) {
    if (!process.env.LHAT_TEST_SEMANTIC_ARTIFACTS) return;
    fs.mkdirSync(process.env.LHAT_TEST_SEMANTIC_ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.LHAT_TEST_SEMANTIC_ARTIFACTS, name + '.svg'), await evaluate('window.exports.at(-1).svg'));
}
async function drillGraphNode({ evaluate, until, call }, node) {
    const selector = `.box.folded[data-source-start="${node.start}"][data-source-end="${node.end}"]`;
    await until(`document.querySelector(${JSON.stringify(selector)}) && ${graphReady}`);
    const position = () => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+8,y:r.top+8}})()`);
    let point = await position();
    if (point.y < 80 || point.y > 600 || point.x < 0 || point.x > 950) {
        await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 350, deltaY: point.y-180, deltaX: point.x < 0 || point.x > 950 ? point.x-200 : 0 });
        await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        point = await position();
    }
    assert(point.x > 0 && point.x < 1000 && point.y > 60 && point.y < 690, JSON.stringify(point));
    for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent', { type, ...point, button:'left', clickCount:1 });
    await until(`document.querySelector('#trail') && ${graphReady}`);
}

test('malformed and missing values repair through the shared expression menu and remain editable', { timeout: 120000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    const flat = n => [n,...Object.values(n.fields ?? {}).flat().flatMap(flat)];
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        for (const [source, expected] of [
            ['let^bad=)\nlet^kept=17', 'let^bad=0\nlet^kept=17'],
            ['let^bad=', 'let^bad=0'],
            ['let^run=p^{let^bad=}', 'let^run=p^{let^bad=0}'],
            ['let^bad=(,17)', 'let^bad=(0,17)'],
            ['let^bad={key=}', 'let^bad={key=0}'],
        ]) {
            const host = await graphHost(parse, server, source);
            await browser({ ...routes, '/':{type:'text/html',body:html(host.tree,false)} }, async client => {
                const ui = await graphUi(host, client); await graphToolbar(client, 'Unfold All');
                const error = flat(host.tree.root).find(n => n.kind === 'error'); assert(error, source);
                await ui.expression(error, 'number');
                assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse(expected)), host.tree.source);
                const value = flat(host.tree.root).find(n => n.kind === 'int' && host.tree.source.slice(n.start,n.end) === '0');
                await ui.input(`.box[data-source-start="${value.start}"] .literal-input`, '23');
                assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse(expected.replace('0','23'))), host.tree.source);
                await ui.add('call');
                assert(!flat(host.tree.root).some(n => n.kind === 'error'), host.tree.source);
                assert.deepEqual(client.errors, []);
            });
        }
    });
});

test('malformed declarations delete their stray tokens while retaining following statements and closing braces', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        for (const [source, expected] of [
            ['let^bad=)\nlet^kept=17', 'let^kept=17'],
            ['let^run=p^{let^bad=) print(17)}', 'let^run=p^{print(17)}'],
            ['let^run=p^{let^bad=}', 'let^run=p^{}'],
        ]) {
            const host = await graphHost(parse, server, source);
            await browser({ ...routes, '/':{type:'text/html',body:html(host.tree,false)} }, async client => {
                const ui = await graphUi(host, client), flat = n => [n,...Object.values(n.fields ?? {}).flat().flatMap(flat)];
                await graphToolbar(client, 'Unfold All');
                await ui.remove(flat(host.tree.root).find(n => n.kind === 'define' && n.fields.values?.some(v => v.kind === 'error')));
                assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse(expected)), host.tree.source);
                assert.deepEqual(client.errors, []);
            });
        }
    });
});

test('invalid standalone statements repair into calls and keep their enclosing procedure editable', { timeout: 60000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'let^run=p^{17}');
        await browser({ ...routes, '/':{type:'text/html',body:html(host.tree,false)} }, async client => {
            const ui = await graphUi(host, client), body = () => host.tree.root.fields.items[0].fields.values[0].fields.body;
            await graphToolbar(client, 'Unfold All');
            await ui.expression(body().fields.items[0], 'call');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('let^run=p^{(print(nil^))(nil^)}')), host.tree.source);
            await ui.remove(body().fields.items[0]); await ui.add('call', body());
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('let^run=p^{print(nil^)}')), host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('recovery views preserve invalid text surrounding values and scoped edit targets', { timeout: 90000 }, async () => {
    const source = 'let^run=p^{let^bad=) print(17)} let^kept=19';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), fn = tree.root.fields.items[0].fields.values[0];
        const error = fn.fields.body.fields.items[0].fields.values[0]; assert.equal(error.kind, 'error');
        await browser({ ...routes, '/':{type:'text/html',body:html(tree,false)} }, async client => {
            const initial = (await svgTexts(client)).join(''); for (const name of ['run','kept']) assert(initial.includes(name));
            const check = async inside => {
                const texts = await svgTexts(client), text = texts.join('');
                assert(text.includes('bad') && texts.includes(')'), text);
                assert.equal(texts.filter(t => t === '17').length, 1, text);
                assert.equal(texts.filter(t => t === '19').length, inside ? 0 : 1, text);
                assert(await client.evaluate(`!!document.querySelector('.expression-edit[data-expression-start="${error.start}"][data-expression-end="${error.end}"]')`));
            };
            await graphToolbar(client, 'Unfold All'); await check(false); await saveSemanticSvg(client, 'recovery-values');
            await graphToolbar(client, 'Fold All'); assert((await svgTexts(client)).join('').includes('run'));
            await drillGraphNode(client, fn); await graphToolbar(client, 'Unfold All'); await check(true);
            assert.equal(await client.evaluate('window.edits.length'), 0); assert.deepEqual(client.errors, []);
        });
    });
});

test('language AST cases render and export in normal, folded and drilled views without broken geometry', { timeout: 600000 }, async () => {
    const { languageCases, declaredKinds } = require('./graph-language-cases.cjs');
    const artifactDirectory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lhat-ast-audit-'));
    const cases = languageCases(), seen = new Set(), manifest = [];
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const trees = [];
        for (const item of cases) {
            const tree = await parse(item.source);
            const visit = node => { seen.add(node.kind); if (!item.recovery) assert.notEqual(node.kind, 'error', item.name); Object.values(node.fields ?? {}).flat().forEach(visit); };
            visit(tree.root); trees.push(tree);
        }
        assert.deepEqual(declaredKinds().filter(kind => !seen.has(kind)), ['annotation'], 'annotations are recovered from source instead of the AST response');
        for (const [index, item] of cases.entries()) await browser({ ...routes, '/': { type: 'text/html', body: html(trees[index]) } }, async client => {
            const { evaluate, until, call, errors } = client;
            const ready = `!document.querySelector('.svg-export>button').disabled`;
            const snapshot = async (item, index, mode) => {
                await until(ready);
                const geometry = await evaluate(`(()=>({nodes:document.querySelectorAll('.react-flow__node').length,
                    invalid:[...document.querySelectorAll('.react-flow__node')].filter(e=>{const r=e.getBoundingClientRect();return ![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.width<0||r.height<0}).length,
                    badEdges:[...document.querySelectorAll('.react-flow__edge-path')].filter(e=>/NaN|undefined|Infinity/.test(e.getAttribute('d'))).length}))()`);
                assert(geometry.nodes > 0, `${item.name}: ${mode}`);
                assert.equal(geometry.invalid + geometry.badEdges, 0, `${item.name}: ${mode}`);
                const previous = await evaluate(`window.exports.length`);
                await evaluate(`document.querySelector('.svg-export>button').click()`);
                await until(`document.querySelector('.svg-export-menu>button')`);
                await evaluate(`(()=>{const inputs=document.querySelectorAll('.svg-export-menu input');if(!inputs[1].checked)inputs[1].click()})()`);
                await evaluate(`document.querySelector('.svg-export-menu>button').click()`);
                await until(`window.exports.length>${previous}`);
                const exported = await evaluate(`(()=>{const svg=window.exports.at(-1).svg,doc=new DOMParser().parseFromString(svg,'image/svg+xml');return {svg,error:doc.querySelector('parsererror')?.textContent,
                    viewBox:doc.documentElement.getAttribute('viewBox').split(' ').map(Number),
                    broken:[...doc.querySelectorAll('[marker-end]')].filter(e=>!doc.getElementById(e.getAttribute('marker-end').slice(5,-1))).length,
                    badPaths:[...doc.querySelectorAll('path')].filter(e=>/NaN|undefined|Infinity/.test(e.getAttribute('d'))).length}})()`);
                assert(!exported.error, `${item.name}: ${mode}`);
                assert(exported.viewBox.every(Number.isFinite) && exported.viewBox[2] > 0 && exported.viewBox[3] > 0, `${item.name}: ${mode}`);
                assert.equal(exported.broken + exported.badPaths, 0, `${item.name}: ${mode}`);
                const file = `${index}-${mode}.svg`;
                fs.writeFileSync(path.join(artifactDirectory, file), exported.svg);
                manifest.push({ name: item.name, mode, file, ...geometry, viewBox: exported.viewBox });
            };
                await until(`document.querySelector('#app')?.dataset.graphVersion==='1' && ${ready}`);
                await snapshot(item, index, 'normal');
                await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await until(ready);
                await snapshot(item, index, 'expanded');
                if (['annotation','procedure','callable-modifiers','coroutine','position-types','handlers','cleanup-transfer','quoted-names'].includes(item.name)) {
                    if (item.name === 'annotation') assert(await evaluate(`!!document.querySelector('.annotation-box')`));
                    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
                    fs.writeFileSync(path.join(artifactDirectory, `${index}-expanded.png`), Buffer.from(screenshot.data, 'base64'));
                }
                await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Fold All')?.click()`);
                await until(ready);
                await snapshot(item, index, 'folded');
                const selector = '.box.folded:not(.comment-box):not(.annotation-box)';
                const target = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e){const r=e.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height}}})()`);
                if (target) {
                    if (target.y < 80 || target.y > 600 || target.x < 0 || target.x > 950) {
                        await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x:500, y:350, deltaY:target.y - 180, deltaX:target.x < 0 || target.x > 950 ? target.x - 200 : 0 });
                        await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
                    }
                    const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.max(8,r.left+8),y:r.top+8}})()`);
                    assert(point.x > 0 && point.x < 1000 && point.y > 60 && point.y < 690, `${item.name}: folded node is not reachable`);
                    for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent', { type, ...point, button:'left', clickCount:1 });
                    await until(`document.querySelector('#trail') && ${ready}`);
                    await snapshot(item, index, 'drilled');
                    await evaluate(`document.querySelector('#trail button').click()`);
                    await until(`!document.querySelector('#trail') && ${ready}`);
                }
                assert.deepEqual(errors, [], item.name);
        });
    });
    fs.writeFileSync(path.join(artifactDirectory, 'coverage.json'), JSON.stringify({ kinds: [...seen].sort(), views: manifest }, null, 2));
    console.log(`AST audit artifacts: ${artifactDirectory}`);
});

test('drilling a condition preserves its expression editors instead of opening the same-start clause', { timeout: 60000 }, async () => {
    const source = 'if^"aaaaa" = "aaaaa" { break^ }';
    const n = (kind, start, end, fields) => ({ kind, start, end, line: 1, column: start + 1, fields });
    const right = source.indexOf('"aaaaa"', 4);
    const predicate = n('binary', 3, right + 7, { left: n('string', 3, 10), right: n('string', right, right + 7) });
    const clause = n('if-clause', 3, source.length, { condition: predicate,
        body: n('block', source.indexOf('{'), source.length, { items: [n('break', source.indexOf('break^'), source.indexOf('break^') + 6)] }) });
    const reply = { source, root: n('block', 0, source.length, { items: [n('if-stmt', 0, source.length, { items: [clause] })] }) };
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, call, errors }) => {
        await until(`document.querySelector('[data-id^="condition-"] .foldbtn') && !document.querySelector('.svg-export>button').disabled`);
        await evaluate(`document.querySelector('[data-id^="condition-"] .foldbtn').click()`);
        await until(`document.querySelectorAll('textarea.literal-input').length===2 && !document.querySelector('.svg-export>button').disabled`);
        const before = await evaluate(`[...document.querySelectorAll('textarea.literal-input')].map(e=>e.value)`);
        await evaluate(`document.querySelector('[data-id^="condition-"] .foldbtn').click()`);
        await until(`document.querySelectorAll('textarea.literal-input').length===0 && !document.querySelector('.svg-export>button').disabled`);
        const point = await evaluate(`(()=>{const r=document.querySelector('[data-id^="condition-"] .box').getBoundingClientRect();return {x:r.left+15,y:r.top+35}})()`);
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
        await until(`document.querySelectorAll('textarea.literal-input').length===2 && !document.querySelector('.svg-export>button').disabled`);
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('textarea.literal-input')].map(e=>e.value)`), before);
        assert.equal(await evaluate(`document.querySelectorAll('[data-id^="condition-"]').length`), 1);
        assert.equal(await evaluate(`document.querySelectorAll('.react-flow__edge-execution').length`), 0);
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('nested interpolation expressions connect all visible output rows back to their holes', { timeout: 60000 }, async () => {
    await browser({ ...routes, '/': { type: 'text/html', body: html(nestedInterpolation()) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelectorAll('.react-flow__edge-operand-definition .react-flow__edge-path').length===4 && !document.querySelector('.svg-export>button').disabled`);
        const wires = await evaluate(`[...document.querySelectorAll('.react-flow__edge-operand-definition .react-flow__edge-path')].map(e=>e.getAttribute('d'))`);
        assert(wires.every(d => d && !d.includes('NaN')));
        assert.equal(new Set(wires).size, 4);
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('interpolation renders editable text/format/value columns and sends source edits', { timeout: 60000 }, async () => {
    await browser({ ...routes, '/': { type: 'text/html', body: html(interpolation()) } }, async ({ evaluate, until, call, errors }) => {
        await call('Emulation.setFocusEmulationEnabled', { enabled: true });
        await until(`document.querySelectorAll('.interpolation-input').length===4 && !document.querySelector('.svg-export>button').disabled`);
        const view = await evaluate(`(()=>{
            const elements=[...document.querySelectorAll('.interpolation-input')];
            return {texts:elements.map(e=>e.value),formats:document.querySelectorAll('.interpolation-field.format').length,
                wires:document.querySelectorAll('.react-flow__edge-operand-definition .react-flow__edge-path').length,
                title:[...document.querySelectorAll('.boxlabel')].some(n=>n.textContent==='フォーマット'),
                add:!!document.querySelector('[data-id^="interpolation-add-"] .statement-button svg'),
                headers:[...document.querySelectorAll('.interpolation-format-header')].map(e=>e.getBoundingClientRect().top),
                values:[...document.querySelectorAll('[data-id^="interp-text-"] .box,[data-id^="operand-slot-"] .box')].map(e=>e.getBoundingClientRect().top),
                quotes:document.querySelectorAll('[data-id^="interp-text-"] .literal-quote').length,
                row:!!document.querySelector('[data-id^="interp-"] .operator-expression'),
                inline:[...document.querySelectorAll('.box')].some(e=>e.textContent.includes('v2') && e.textContent.includes('数値') && !e.classList.contains('container'))};
        })()`);
        assert(view.title); assert(view.add); assert(view.inline); assert.equal(view.formats, 2); assert.equal(view.wires, 1);
        assert(view.row); assert.equal(view.quotes, 4);
        assert.equal(view.headers.length, 2); assert.equal(view.values.length, 3);
        assert(Math.max(...view.headers) - Math.min(...view.headers) < 1, 'column headings align');
        assert(Math.max(...view.values) - Math.min(...view.values) < 1, 'text and type boxes align');
        assert(Math.max(...view.headers) < Math.min(...view.values), 'format fields sit above the shared expression row');
        assert(view.texts.includes('text1')); assert(view.texts.includes('text2'));
        const addSize = await evaluate(`(()=>{const r=document.querySelector('[data-id^="interpolation-add-"] .statement-button').getBoundingClientRect();return {width:r.width,height:r.height}})()`);
        assert(Math.abs(addSize.width - addSize.height) < 0.1, 'small add button is circular');
        assert(Math.abs(addSize.width - 15.4) < 0.2, 'uses the standard small add button size');
        const edit = async (selector, value, cancel = false) => {
            await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
            await evaluate(`(()=>{
                const input=document.querySelector(${JSON.stringify(selector)});
                Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});
                input.dispatchEvent(new Event('input',{bubbles:true}));
            })()`);
            await evaluate(`(()=>{
                const input=document.querySelector(${JSON.stringify(selector)});
                ${cancel ? "input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));" : 'input.blur();'}
            })()`);
        };
        await edit('.interpolation-field.text textarea', 'changed {x}');
        await until('window.edits.length===1');
        assert.deepEqual(await evaluate('({field:window.edits[0].site.field,value:window.edits[0].value})'), { field: 'text', value: 'changed {x}' });
        await edit('.interpolation-field.format textarea', '%04d');
        await until('window.edits.length===2');
        assert.equal(await evaluate('window.edits[1].site.field'), 'format');
        await edit('.interpolation-field.text textarea', 'cancelled', true);
        assert.equal(await evaluate('window.edits.length'), 2);
        await evaluate(`document.querySelector('[data-id^="interpolation-add-"] .statement-button').click()`);
        await until(`document.querySelectorAll('.statement-menu [role="option"]').length===2`);
        await evaluate(`document.querySelectorAll('.statement-menu [role="option"]')[1].click()`);
        await until('window.edits.length===3');
        assert.equal(await evaluate('window.edits[2].site.field'), 'append');
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('loop clauses render side branches, a condition box and an outer return without missing handles', { timeout: 60000 }, async () => {
    const source = 'for^i := 0 while^true^ next^i += 1 { pre^: before() first^: once() main^: work() last^: last() epilog^: after() }';
    const n = (kind, text, fields) => ({ kind, start: source.indexOf(text), end: source.indexOf(text) + text.length, line: 1, column: 1, fields });
    const call = name => {
        const value = n('call', `${name}()`, { target: n('ident', name), args: [] });
        value.callable = { inputs: [], outputs: [] };
        return n('call-stmt', `${name}()`, { value });
    };
    const body = n('block', source.slice(source.indexOf('{')), { items: [call('work')], extra:
        [['pre', 'before'], ['first', 'once'], ['last', 'last'], ['epilog', 'after']]
            .map(([clause, name]) => n('loop-clause', `${clause}^: ${name}()`, { body: [call(name)] })) });
    const loop = n('for', source, { focus: [n('reassign', 'i := 0')], bound: n('hat-ident', 'true^'), advance: [n('reassign', 'i += 1')], body });
    await browser({ ...routes, '/': { type: 'text/html', body: html({ source, root: n('block', source, { items: [loop] }) }) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelector('.react-flow__edge-execution-loop .react-flow__edge-path') && !document.querySelector('.svg-export>button').disabled`);
        const result = await evaluate(`(()=>{
            const path=document.querySelector('.react-flow__edge-execution-loop .react-flow__edge-path');
            const first=document.querySelector('.react-flow__node[data-id^="loop-first-"]');
            const header=first.querySelector('[data-handleid="flow-branch"]').getBoundingClientRect();
            const condition=document.querySelector('.react-flow__node[data-id^="condition-"]').getBoundingClientRect();
            const clause=document.querySelector('.box[data-source-start="${source.indexOf('first^')}"]').getBoundingClientRect();
            const next=document.querySelector('.box[data-source-start="${source.indexOf('next^')}"]');
            const main=document.querySelector('.box[data-source-start="${source.indexOf('work()')}"]').getBoundingClientRect();
            return {path:path.getAttribute('d'), marker:path.getAttribute('marker-end'),
                nextAfterMain:next.getBoundingClientRect().top>=main.bottom,
                nextTitle:next.querySelector('.boxlabel').textContent,
                bypasses:document.querySelectorAll('.react-flow__edge-execution-bypass .react-flow__edge-path').length,
                bypassArrows:[...document.querySelectorAll('.react-flow__edge-execution-bypass .react-flow__edge-path')]
                    .map(n=>{const ref=n.getAttribute('marker-end');
                        return [...document.querySelectorAll('marker')].some(marker=>
                            ref?.includes('#'+marker.id) && !!marker.querySelector('polyline, path'));}),
                condition:[...document.querySelectorAll('.boxlabel')].some(n=>n.textContent.includes('条件付き繰り返し')),
                side:clause.left>header.right,
                conditionAxis:condition.left+condition.width/2,
                entryAxis:header.left+header.width/2,
                arrows:document.querySelector('.react-flow__edge-execution-loop .loop-direction-arrows')?.getAttribute('d'),
                otherArrows:document.querySelectorAll('.react-flow__edge:not(.react-flow__edge-execution-loop) .loop-direction-arrows').length};
        })()`);
        assert(result.path && !/NaN|undefined/.test(result.path));
        assert(result.marker);
        assert.equal(result.bypasses, 3);
        assert.deepEqual(result.bypassArrows, [true, true, true], 'every invisible loop merge has a rendered arrowhead');
        assert(result.condition);
        assert(result.side);
        assert(result.nextAfterMain);
        assert.equal(result.nextTitle, '次の繰り返し:');
        assert(Math.abs(result.conditionAxis - result.entryAxis) < 1,
            `condition must cover the execution line entering first: ${JSON.stringify(result)}`);
        assert(result.arrows && result.arrows.split('M ').length > 3, 'return route has repeated direction marks');
        assert.equal(result.otherArrows, 0, 'forward routes retain their original appearance');
        await evaluate(`document.querySelector('.svg-export>button').click()`);
        await until(`document.querySelector('.svg-export-menu>button')`);
        await evaluate(`document.querySelector('.svg-export-menu>button').click()`);
        await until('window.exports.length===1');
        const exportedArrows = await evaluate(`(()=>{
            const doc=new DOMParser().parseFromString(window.exports[0].svg,'image/svg+xml');
            return [...doc.querySelectorAll('path')].some(path=>path.getAttribute('d')===${JSON.stringify(result.arrows)});
        })()`);
        assert(exportedArrows, 'SVG exports retain the direction marks');
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('until conditions sit on the exit lane with and without first clauses', { timeout: 60000 }, async () => {
    for (const sectioned of [false, true]) {
        const source = `repeat^until^done { ${sectioned ? 'pre^: before() first^: once() main^: ' : ''}work() }`;
        const n = (kind, text, fields) => ({ kind, start: source.indexOf(text), end: source.indexOf(text) + text.length, line: 1, column: 1, fields });
        const body = n('block', source.slice(source.indexOf('{')), { items: [n('call-stmt', 'work()')],
            extra: sectioned ? [n('loop-clause', 'pre^: before()', { body: [n('call-stmt', 'before()')] }),
                n('loop-clause', 'first^: once()', { body: [n('call-stmt', 'once()')] })] : [] });
        const loop = n('repeat', source, { bound: n('ident', 'done'), body });
        await browser({ ...routes, '/': { type: 'text/html', body: html({ source, root: n('block', source, { items: [loop] }) }) } }, async ({ evaluate, until, errors }) => {
            await until(`document.querySelector('.react-flow__edge-execution-bypass .react-flow__edge-path') && !document.querySelector('.svg-export>button').disabled`);
            const result = await evaluate(`(()=>{
                const gate=document.querySelector('.react-flow__node[data-id^="loop-test-"]');
                const edge=[...document.querySelectorAll('.react-flow__edge-execution-bypass')].find(edge=>edge.getAttribute('data-id').includes(gate.getAttribute('data-id')));
                const line=edge.querySelector('.react-flow__edge-path').getBoundingClientRect();
                const condition=document.querySelector('.react-flow__node[data-id^="condition-"]').getBoundingClientRect();
                const main=document.querySelector('.react-flow__node[data-id^="loop-main-"]').getBoundingClientRect();
                return {axis:condition.left+condition.width/2,lane:line.left,
                    onVertical:line.top<condition.top && line.bottom>condition.bottom,
                    separate:condition.right<=main.left};
            })()`);
            assert(Math.abs(result.axis - result.lane) < 1, JSON.stringify(result));
            assert(result.onVertical);
            assert(result.separate);
            assert.equal(errors.length, 0, JSON.stringify(errors));
        });
    }
});

test('numeric range arrows are SVG shapes aligned with both value boxes', { timeout: 60000 }, async () => {
    const source = 'for^i from^0 to^5 {}';
    const n = (kind, text, fields) => ({ kind, start: source.indexOf(text), end: source.indexOf(text) + text.length, line: 1, column: 1, fields });
    const focus = n('define', 'i from^0', { targets: [n('ident', 'i')], values: [n('int', '0')] });
    const loop = n('for', source, { focus: [focus], bound: n('int', '5'), body: n('block', '{}', { items: [] }) });
    await browser({ ...routes, '/': { type: 'text/html', body: html({ source, root: n('block', source, { items: [loop] }) }) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelector('.range-arrow-icon path') && !document.querySelector('.svg-export>button').disabled`);
        const result = await evaluate(`(()=>{
            const center=element=>{const rect=element.getBoundingClientRect();return rect.top+rect.height/2;};
            const value=text=>[...document.querySelectorAll('.literal-number input')].find(input=>input.value===text).closest('.box');
            const arrow=document.querySelector('.range-arrow-icon');
            return {start:center(value('0')),end:center(value('5')),arrow:center(arrow),text:arrow.textContent};
        })()`);
        assert(Math.abs(result.start - result.end) < 1, JSON.stringify(result));
        assert(Math.abs(result.start - result.arrow) < 1, JSON.stringify(result));
        assert.equal(result.text, '');
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('index brackets contain inline values or holes, with complex targets and subscripts below', { timeout: 60000 }, async () => {
    for (const options of [{}, { simple: true }, { targetCall: true, indexCall: true }, { optional: true, simple: true }]) {
        const reply = indexExpression(options);
        const wires = options.simple ? 0 : options.targetCall ? 2 : 1;
        await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, errors }) => {
            const selector = `.operator-expression[data-source-start="0"][data-source-end="${reply.source.length}"]`;
            await until(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('.svg-export>button').disabled &&
                document.querySelectorAll('.react-flow__edge-operand-definition .react-flow__edge-path').length===${wires}`);
            const result = await evaluate(`(()=>{
                const row=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
                const inside=n=>{const r=n.getBoundingClientRect();return r.left>=row.left && r.right<=row.right && r.top>=row.top && r.bottom<=row.bottom};
                return {holes:[...document.querySelectorAll('.operand-slot')].filter(inside).length,
                    brackets:[...document.querySelectorAll('.box.decoration')].filter(inside).map(n=>n.textContent),
                    calls:[...document.querySelectorAll('.call-node')].map(n=>({below:n.getBoundingClientRect().top>row.bottom})),
                    nested:[...document.querySelectorAll('.operator-expression')].filter(n=>n!==document.querySelector(${JSON.stringify(selector)}))
                        .map(n=>({below:n.getBoundingClientRect().top>row.bottom})),
                    wires:document.querySelectorAll('.react-flow__edge-operand-definition .react-flow__edge-path').length};
            })()`);
            assert.equal(result.holes, Number(!!options.targetCall) + Number(!options.simple));
            assert.deepEqual(result.brackets, [options.optional ? '?[' : '[', ']']);
            assert.equal(result.wires, wires);
            assert(result.calls.every(call=>call.below));
            assert(result.nested.every(expression=>expression.below));
            assert.equal(errors.length, 0, JSON.stringify(errors));
        });
    }
});

test('already-bound Slice metadata renders a Method Call with Self and both numeric inputs', { timeout: 60000 }, async () => {
    await browser({ ...routes, '/': { type: 'text/html', body: html(boundSlice()) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelector('.io-self') && !document.querySelector('.svg-export>button').disabled`);
        const result = await evaluate(`(()=>{
            const self=document.querySelector('.io-self').getBoundingClientRect();
            const value=[...document.querySelectorAll('.box[data-source-start="0"][data-source-end="6"]')]
                .find(n=>{const r=n.getBoundingClientRect();return r.left>self.left && r.right<self.right && r.top>self.top && r.bottom<self.bottom});
            return {title:document.querySelector('.call-node>.boxlabel').textContent,receiver:!!value,
                inputs:document.querySelectorAll('.react-flow__node[data-id^="input-slot-"]').length,
                values:[...document.querySelectorAll('.literal-number input')].map(n=>n.value),
                wires:document.querySelectorAll('.react-flow__edge-call-definition .react-flow__edge-path').length};
        })()`);
        assert.equal(result.title, 'メソッド呼び出し');
        assert(result.receiver);
        assert.equal(result.inputs, 2);
        assert.deepEqual(result.values, ['1', '2']);
        assert.equal(result.wires, 2);
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('operator holes match numeric pills and translated operators have no redundant heading', { timeout: 60000 }, async () => {
    const source = '(1 + 2) * 3 and^ true^';
    const n = (kind, text, fields) => ({ kind, start: source.indexOf(text), end: source.indexOf(text) + text.length, line: 1, column: 1, fields });
    const sum = n('binary', '1 + 2', { left: n('int', '1'), right: n('int', '2') });
    const product = n('binary', '(1 + 2) * 3', { left: sum, right: n('int', '3') });
    const reply = { source, root: n('binary', source, { left: product, right: n('hat-ident', 'true^') }) };
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelector('.operand-slot') && !document.querySelector('.svg-export>button').disabled`);
        const result = await evaluate(`(()=>{
            const hole=document.querySelector('.operand-slot'), number=[...document.querySelectorAll('.literal-number')].find(n=>n.querySelector('input').value==='3');
            return {holeWidth:hole.getBoundingClientRect().width,numberWidth:number.getBoundingClientRect().width,
                holeRadius:getComputedStyle(hole).borderRadius,numberRadius:getComputedStyle(number).borderRadius,
                operators:[...document.querySelectorAll('.operator-cell')].map(n=>({text:n.textContent,clipped:n.scrollWidth>n.clientWidth || n.scrollHeight>n.clientHeight}))};
        })()`);
        assert.equal(result.holeWidth, result.numberWidth);
        assert.equal(result.holeRadius, result.numberRadius);
        assert(result.operators.some(op=>op.text==='かつ'));
        assert(result.operators.every(op=>!op.clipped && !op.text.includes('Operator') && !op.text.includes('演算子')));
        await evaluate(`window.postMessage({type:'localization',language:'en'},'*')`);
        await until(`[...document.querySelectorAll('.operator-cell')].some(n=>n.textContent==='And') && !document.querySelector('.svg-export>button').disabled`);
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('method calls show Self above Input and route only complex receivers outside the card', { timeout: 60000 }, async () => {
    for (const receiver of ['dense', 'make()']) {
        const reply = methodCall({ receiver });
        await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, errors }) => {
            await until(`document.querySelector('.io-self') && !document.querySelector('.svg-export>button').disabled`);
            const result = await evaluate(`(()=>{
                const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
                const self=document.querySelector('.io-self'), s=rect(self), input=document.querySelector('.io-input');
                const method=[...document.querySelectorAll('.call-node')].find(n=>n.querySelector('.boxlabel').textContent==='メソッド呼び出し');
                const wires=[...document.querySelectorAll('.react-flow__edge-call-definition .react-flow__edge-path')].filter(path=>{
                    const p=path.getPointAtLength(path.getTotalLength()), point=new DOMPoint(p.x,p.y).matrixTransform(path.getScreenCTM());
                    return point.x>s.x && point.x<s.x+s.w && point.y>s.y && point.y<s.y+s.h;
                });
                return {self:s,input:rect(input),card:rect(method),selfLabel:self.textContent,selfWires:wires.length,
                    calls:document.querySelectorAll('.call-node').length,inputSlots:document.querySelectorAll('.react-flow__node[data-id^="input-slot-"]').length};
            })()`);
            assert.equal(result.selfLabel, '自身');
            assert(result.self.y + result.self.h < result.input.y);
            assert(result.self.x > result.card.x && result.self.x + result.self.w < result.card.x + result.card.w);
            assert.equal(result.calls, receiver === 'dense' ? 1 : 2);
            assert.equal(result.inputSlots, 1);
            assert.equal(result.selfWires, receiver === 'dense' ? 0 : 1);
            await evaluate(`window.postMessage({type:'localization',language:'en'},'*')`);
            await until(`[...document.querySelectorAll('.call-node>.boxlabel')].some(n=>n.textContent==='Method Call') && !document.querySelector('.svg-export>button').disabled`);
            assert.equal(await evaluate(`document.querySelector('.io-self legend').textContent`), 'Self');
            assert.equal(errors.length, 0, JSON.stringify(errors));
        });
    }
});

test('operator expressions embed primitives and route external operands outside all visible boxes', { timeout: 60000 }, async () => {
    const reply = operatorExpression();
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelectorAll('.react-flow__edge-operand-definition .react-flow__edge-path').length===3 && !document.querySelector('.svg-export>button').disabled`);
        const inspect = () => evaluate(`(()=>{
            const rows=[...document.querySelectorAll('.operator-expression')];
            const boxes=[...document.querySelectorAll('.box')].map(box=>({rect:box.getBoundingClientRect(),label:box.textContent,kind:box.className}));
            const overlaps=[];
            let collisions=0;
            for(const path of document.querySelectorAll('.react-flow__edge-operand-definition .react-flow__edge-path')) {
                const matrix=path.getScreenCTM(), length=path.getTotalLength();
                for(let t=2;t<length-2;t+=2) {
                    const p=path.getPointAtLength(t), point=new DOMPoint(p.x,p.y).matrixTransform(matrix);
                    for(const box of boxes){const r=box.rect;if(point.x>r.left+1 && point.x<r.right-1 && point.y>r.top+1 && point.y<r.bottom-1){collisions++;overlaps.push({box:box.label,kind:box.kind,x:point.x,y:point.y,rect:r.toJSON(),path:path.getAttribute('d')});break;}}
                }
            }
            return {rows:rows.length,slots:document.querySelectorAll('.operand-slot').length,
                calls:document.querySelectorAll('.call-node').length,collisions,overlaps,
                literalValues:[...document.querySelectorAll('input,textarea')].map(e=>e.value)};
        })()`);
        const first = await inspect();
        assert.equal(first.rows, 3);
        assert.equal(first.slots, 3);
        assert.equal(first.calls, 1);
        assert.equal(first.collisions, 0, JSON.stringify(first));
        for (const value of ['1', '2', '3', '4', '5', '6']) assert(first.literalValues.includes(value));
        await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='A+').click()`);
        await until(`!document.querySelector('.svg-export>button').disabled`);
        const enlarged = await inspect();
        assert.equal(enlarged.collisions, 0, JSON.stringify(enlarged));
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('catch handlers render beside the main body with error types inside their Catch boxes', { timeout: 60000 }, async () => {
    const reply = catchFlow();
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelectorAll('.box').length>0 && !document.querySelector('.svg-export>button').disabled`);
        assert.equal(await evaluate(`document.querySelectorAll('[data-role="catch"]').length`), 2,
            await evaluate(`document.querySelector('#flow').textContent`));
        const geometry = await evaluate(`(()=>{
            const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
            const call=start=>rect(document.querySelector('.call-node[data-source-start="'+start+'"]'));
            return {headers:[...document.querySelectorAll('[data-role="catch"]')].map(e=>{
                    const box=e.closest('.box'), summary=box.querySelector('.fold-summary');
                    return {...rect(box),summary:summary?.textContent,filter:summary?rect(summary):null};}),
                separateErrors:document.querySelectorAll('[data-role="error"]').length,
                main:call(${reply.source.indexOf('work()')}),
                eof:call(${reply.source.indexOf('print("eof")')}), other:call(${reply.source.indexOf('print("other")')})};
        })()`);
        assert(geometry.headers[0].x > geometry.main.x + geometry.main.w);
        assert(geometry.headers[1].x > geometry.eof.x + geometry.eof.w);
        assert(Math.abs(geometry.headers[0].y - geometry.headers[1].y) < 1);
        assert.equal(geometry.headers[0].summary, 'IOError.Eof');
        assert.equal(geometry.headers[1].filter, null);
        assert.equal(geometry.separateErrors, 0);
        assert(geometry.headers[0].filter.y > geometry.headers[0].y);
        assert(geometry.headers[0].filter.y + geometry.headers[0].filter.h <= geometry.headers[0].y + geometry.headers[0].h);
        assert(geometry.eof.y > geometry.headers[0].y + geometry.headers[0].h);
        assert(geometry.other.y > geometry.headers[1].y + geometry.headers[1].h);
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('AST comments render above their owner as separate multiline boxes', { timeout: 60000 }, async () => {
    const reply = { source, root: structuredClone(root) };
    const owner = reply.root.fields.items[0].fields.values[0];
    owner.comments = [];
    for (const text of ['# function comment', '#[ 日本語のコメント\nsecond line ]#']) {
        reply.source += '\n';
        const start = reply.source.length;
        reply.source += text;
        owner.comments.push({ start, end: reply.source.length, block: text.startsWith('#[') });
    }
    reply.root.end = reply.source.length;
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, call, errors }) => {
        await until(`document.querySelectorAll('.comment-box').length===2 && !document.querySelector('.svg-export>button').disabled`);
        const result = await evaluate(`(()=>{
            const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
            const owner=document.querySelector('.box.folded[data-source-start="${owner.start}"]');
            return {owner:rect(owner),comments:[...document.querySelectorAll('.comment-box')].map(e=>({
                ...rect(e),text:(e.querySelector('textarea')?.value ?? e.querySelector('.comment-text')?.textContent),title:e.title,handles:e.parentElement.querySelectorAll('.react-flow__handle').length,
                overflow:e.querySelector('.comment-text, textarea').getBoundingClientRect().bottom>e.getBoundingClientRect().bottom}))};
        })()`);
        assert.equal(result.comments[0].text, 'function comment');
        assert.equal(result.comments[1].text, '日本語のコメント\nsecond line');
        for (const comment of result.comments) {
            assert(comment.title.startsWith('func '));
            assert(Math.abs(comment.x + comment.w / 2 - result.owner.x - result.owner.w / 2) < 1);
            assert(comment.y + comment.h < result.owner.y);
            assert.equal(comment.handles, 0);
            assert.equal(comment.overflow, false);
        }
        assert(result.comments[0].y + result.comments[0].h < result.comments[1].y);
        const inspectLinks = async () => {
            const links = await evaluate(`(()=>{const owner=document.querySelector('.box.folded[data-source-start="${owner.start}"]').getBoundingClientRect();return [...document.querySelectorAll('.comment-link path')].map(path=>{const p=path.getPointAtLength(path.getTotalLength()),end=new DOMPoint(p.x,p.y).matrixTransform(path.getScreenCTM());return {x:end.x,y:end.y,left:owner.left,right:owner.right,top:owner.top,dash:getComputedStyle(path).strokeDasharray,pointer:getComputedStyle(path).pointerEvents}})})()`);
            assert.equal(links.length, 2);
            for (const link of links) {
                assert(link.x >= link.left && link.x <= link.right);
                assert(Math.abs(link.y - link.top) < 2, JSON.stringify(link));
                assert.notEqual(link.dash, 'none'); assert.equal(link.pointer, 'none');
            }
        };
        await inspectLinks();
        const toggle = async () => {
            const point = await evaluate(`(()=>{const r=document.querySelectorAll('.comment-box .foldbtn')[1].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
            await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
            await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        };
        await toggle();
        await until(`document.querySelectorAll('.comment-box .foldbtn')[1].getAttribute('aria-expanded')==='false' && !document.querySelector('.svg-export>button').disabled`);
        assert.equal(await evaluate(`(document.querySelectorAll('.comment-box')[1].querySelector('textarea')?.value ?? document.querySelectorAll('.comment-box')[1].querySelector('.comment-text')?.textContent)`), '日本語のコメント…');
        assert(await evaluate(`document.querySelectorAll('.comment-box')[1].getBoundingClientRect().height`) < result.comments[1].h);
        await toggle();
        await until(`document.querySelectorAll('.comment-box .foldbtn')[1].getAttribute('aria-expanded')==='true' && !document.querySelector('.svg-export>button').disabled`);
        assert.equal(await evaluate(`(document.querySelectorAll('.comment-box')[1].querySelector('textarea')?.value ?? document.querySelectorAll('.comment-box')[1].querySelector('.comment-text')?.textContent)`), result.comments[1].text);
        assert.equal(await evaluate(`document.querySelectorAll('.comment-box')[1].getBoundingClientRect().height`), result.comments[1].h);
        await inspectLinks();
        await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='A+').click()`);
        await until(`document.querySelector('#flow').style.getPropertyValue('--lhat-scale')!=='1' && !document.querySelector('.svg-export>button').disabled`);
        await inspectLinks();
        await evaluate(`document.querySelector('.svg-export>button').click()`);
        await until(`document.querySelector('.svg-export-menu>button')`);
        await evaluate(`document.querySelector('.svg-export-menu>button').click()`);
        await until(`window.exports.length===1`);
        assert.equal(await evaluate(`(()=>{const doc=new DOMParser().parseFromString(window.exports[0].svg,'image/svg+xml');return [...doc.querySelectorAll('[data-node-id^="comment__"] path')].filter(p=>p.getAttribute('stroke-dasharray') && p.getAttribute('stroke-dasharray')!=='none').length})()`), 2);
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('foreground comments leave insertion buttons clickable at different text sizes', { timeout: 60000 }, async () => {
    const reply = { source, root: structuredClone(root) };
    const owner = reply.root.fields.items[0];
    const start = reply.source.length + 1;
    reply.source += '\n#[ Statement comment\nwith a second line ]#';
    owner.comments = [{ start, end: reply.source.length, block: true }];
    reply.root.end = reply.source.length;
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, call, errors }) => {
        await until(`document.querySelector('.comment-box') && !document.querySelector('.svg-export>button').disabled`);
        for (const enlarged of [false, true]) {
            if (enlarged) {
                await evaluate(`(()=>{for(let i=0;i<4;i++)document.querySelector('button[title^="Larger text"]').click()})()`);
                await until(`document.querySelector('#flow').style.getPropertyValue('--lhat-scale')==='${16 / 12}' && !document.querySelector('.svg-export>button').disabled`);
            }
            const result = await evaluate(`(()=>{
                const comment=document.querySelector('.comment-box'), r=comment.getBoundingClientRect();
                const owner=document.querySelector('.box[data-source-start="${owner.start}"]');
                const button=owner.parentElement.querySelector('.insert-statement'), b=button.getBoundingClientRect();
                const c=document.createElement('canvas').getContext('2d');c.fillStyle=getComputedStyle(comment).backgroundColor;c.fillRect(0,0,1,1);
                return {bottom:r.bottom,buttonTop:b.top,x:b.x+b.width/2,y:b.y+b.height/2,
                    hit:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===button,
                    alpha:c.getImageData(0,0,1,1).data[3],opacity:getComputedStyle(comment).opacity,
                    z:Number(getComputedStyle(comment.parentElement).zIndex),
                    edgeZ:Math.max(...[...document.querySelectorAll('.react-flow__edge')].map(e=>Number(getComputedStyle(e.closest('svg')).zIndex)))};
            })()`);
            assert(result.bottom < result.buttonTop, 'the whole button stays below the comment');
            assert(result.hit, 'the comment does not intercept button clicks');
            assert(result.z > result.edgeZ, 'comments render above execution lines');
            assert(result.alpha > 0 && result.alpha < 255, 'the background is translucent');
            assert.equal(result.opacity, '1', 'text remains opaque');
            await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: result.x, y: result.y, button: 'left', clickCount: 1 });
            await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: result.x, y: result.y, button: 'left', clickCount: 1 });
            await until(`document.querySelector('.statement-menu')`);
            await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await until(`!document.querySelector('.statement-menu')`);
        }
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('text boxes soft-wrap, grow to five rows and retain wrapped lines in SVG exports', { timeout: 60000 }, async () => {
    const values = ['short', 'Enter an expression using each of them once, or an empty line to finish reading the input.',
        '日本語の長い文章'.repeat(40), 'one\ntwo\nthree\nfour\nfive', 'one\ntwo\nthree\nfour\nfive\nsix\nseven'];
    const reply = { source: '', root: { kind: 'block', start: 0, end: 0, line: 1, column: 1, fields: { items: [] } } };
    for (const value of values) {
        const start = reply.source.length;
        reply.source += JSON.stringify(value);
        reply.root.fields.items.push({ kind: 'string', start, end: reply.source.length, line: 1, column: 1 });
        reply.source += '\n';
    }
    reply.root.end = reply.source.length;
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelectorAll('textarea.literal-input').length===5 && !document.querySelector('.svg-export>button').disabled`);
        const geometry = () => evaluate(`(()=>${JSON.stringify(values)}.map(value=>{
            const e=[...document.querySelectorAll('textarea.literal-input')].find(e=>e.value===value), s=getComputedStyle(e);
            return {width:e.closest('.box').getBoundingClientRect().width,height:e.closest('.box').getBoundingClientRect().height,
                rows:Math.floor((e.clientHeight-parseFloat(s.paddingTop)-parseFloat(s.paddingBottom))/parseFloat(s.lineHeight)),
                horizontal:e.scrollWidth>e.clientWidth,vertical:e.scrollHeight>e.clientHeight,
                id:e.closest('.react-flow__node').dataset.id};
        }))()`);
        const initial = await geometry();
        assert(initial[1].height > initial[0].height, 'long single-line text grows vertically');
        assert.equal(initial[1].vertical, false, 'moderately long text fits without scrolling');
        assert(initial.every(box => !box.horizontal), 'soft wraps remove horizontal overflow');
        for (const index of [2, 3, 4]) assert.equal(initial[index].rows, 5);
        assert.equal(initial[2].width, initial[1].width, 'the width remains clamped');
        assert(initial[2].vertical && initial[4].vertical, 'content beyond five rows scrolls vertically');
        assert.equal(initial[3].vertical, false, 'five explicit lines fit');
        await evaluate(`document.querySelector('.svg-export>button').click()`);
        await until(`document.querySelector('.svg-export-menu>button')`);
        await evaluate(`document.querySelector('.svg-export-menu>button').click()`);
        await until(`window.exports.length===1`);
        const exported = await evaluate(`(()=>{
            const doc=new DOMParser().parseFromString(window.exports[0].svg,'image/svg+xml');
            const node=doc.querySelector('[data-node-id="${initial[1].id}"]');
            const label=document.querySelector('[data-id="${initial[1].id}"] .literal-type-label').textContent;
            return [...node.querySelectorAll('text')].filter(e=>![label,'“','”'].includes(e.textContent))
                .map(e=>({text:e.textContent,y:e.getAttribute('y')}));
        })()`);
        assert.equal(exported.map(line => line.text).join(''), values[1], 'export keeps the entire wrapped value');
        assert(new Set(exported.map(line => line.y)).size > 1, 'SVG text uses multiple visual lines');
        await evaluate(`(()=>{for(let i=0;i<4;i++)document.querySelector('button[title^="Larger text"]').click()})()`);
        await until(`document.querySelector('#flow').style.getPropertyValue('--lhat-scale')==='${16 / 12}' && !document.querySelector('.svg-export>button').disabled`);
        const enlarged = await geometry();
        assert(enlarged.every(box => !box.horizontal));
        for (const index of [2, 3, 4]) assert.equal(enlarged[index].rows, 5);
        assert.equal(enlarged[1].vertical, false);
        const scrollTop = await evaluate(`(()=>{const e=[...document.querySelectorAll('textarea')].find(e=>e.value===${JSON.stringify(values[2])});e.scrollTop=e.scrollHeight;return e.scrollTop})()`);
        assert(scrollTop > 0, 'overflow remains readable by scrolling');
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('editable SVG snapshots preserve the live graph across folding, scrolling, editing and drill-down', { timeout: 60000 }, async () => {
    await browser(routes, async ({ evaluate, until, call, errors }) => {
        await until(`document.querySelectorAll('.react-flow__edge-path').length>2 && !document.querySelector('.svg-export > button')?.disabled`);
        const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const capture = async (background = true, controls = false) => {
            await until(`!document.querySelector('.svg-export > button').disabled`);
            const previous = await evaluate('window.exports.length');
            await evaluate(`document.querySelector('.svg-export > button').click()`); await frame();
            await evaluate(`(()=>{const c=document.querySelectorAll('.svg-export-menu input');if(c[0].checked!==${background})c[0].click();if(c[1].checked!==${controls})c[1].click()})()`); await frame();
            await evaluate(`document.querySelector('.svg-export-menu > button').click()`);
            await until(`window.exports.length>${previous}`); await frame();
            return evaluate(`(()=>{const xml=window.exports.at(-1).svg, doc=new DOMParser().parseFromString(xml,'image/svg+xml');window.exported=doc;
                return {xml,error:doc.querySelector('parsererror')?.textContent,text:[...doc.querySelectorAll('text')].map(t=>t.textContent),
                nodes:doc.querySelectorAll('[data-node-id]').length,edges:doc.querySelectorAll('[data-edge-id]').length,markers:doc.querySelectorAll('marker').length,
                viewBox:doc.documentElement.getAttribute('viewBox').split(' ').map(Number),background:!!doc.querySelector('#background'),
                invalid:doc.querySelectorAll('foreignObject,image,script').length,
                broken:[...doc.querySelectorAll('[marker-end]')].filter(e=>!doc.getElementById(e.getAttribute('marker-end').slice(5,-1))).length};})()`);
        };
        const folded = await capture();
        assert(!folded.error); assert.equal(folded.invalid, 0); assert.equal(folded.broken, 0);
        assert(folded.text.includes('日本語 & <text>')); assert(folded.background); assert(folded.edges > 0); assert(folded.markers >= 2);
        assert(!folded.text.includes('▸')); assert(!folded.text.includes('▾'));
        await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All').click()`);
        await until(`!document.querySelector('.box.folded')`); await frame();
        const expanded = await capture(false, true);
        assert(expanded.nodes > folded.nodes); assert(!expanded.background); assert(expanded.viewBox[3] > 700, 'offscreen nodes are included');
        assert(expanded.text.includes('入力')); assert(expanded.text.includes('出力')); assert(expanded.text.includes('▾'));
        assert(!expanded.xml.includes('color(srgb')); assert(!expanded.xml.includes('var(--'));
        await evaluate(`(()=>{const input=[...document.querySelectorAll('textarea')].find(e=>e.value==='日本語 & <text>');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'編集済み & <SVG>');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await frame();
        const edited = await capture(false);
        assert(edited.text.includes('編集済み & <SVG>'));
        // Pan the live viewport: an export still covers the same complete graph.
        await evaluate(`document.querySelector('.react-flow__viewport').style.transform='translate(-230px,-900px) scale(1)'`);
        const scrolled = await capture(false);
        assert.deepEqual(scrolled.viewBox.slice(2), edited.viewBox.slice(2));
        assert.deepEqual(scrolled.text, edited.text);
        await evaluate(`document.querySelector('.react-flow__viewport').style.transform='translate(0px,0px) scale(1)'`);
        await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Fold All').click()`);
        await until(`document.querySelector('.box.folded[data-source-start="${fn.start}"]')`); await frame();
        const hit = await evaluate(`(()=>{const r=document.querySelector('.box.folded[data-source-start="${fn.start}"]').getBoundingClientRect();return {x:r.left+20,y:r.top+20};})()`);
        for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', {type, ...hit, button:'left',clickCount:1});
        await until(`!!document.querySelector('#trail')`); await frame();
        const drilled = await capture(false);
        assert(drilled.nodes < expanded.nodes); assert(!drilled.text.includes('編集済み & <SVG>'));
        assert(drilled.text.some(text => text.includes('route')), JSON.stringify(drilled.text));
        await evaluate(`(()=>{const s=document.documentElement.style;s.setProperty('--vscode-editor-background','#fff');s.setProperty('--vscode-editor-foreground','#222');s.setProperty('--vscode-lhat-graph-input','#135ace');
            [...document.querySelectorAll('#bar button')].find(b=>b.textContent==='A+').click();})()`);
        const light = await capture();
        assert(light.xml.includes('fill="#ffffff"')); assert(light.xml.includes('#135ace'));
        assert(light.viewBox[3] > drilled.viewBox[3], 'export follows the selected font size');
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('call depth columns, right-aligned inputs and bent definition lines survive horizontal scrolling and SVG export', { timeout: 60000 }, async () => {
    const reply = branchedCalls();
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, call, errors }) => {
        await until(`document.querySelectorAll('.call-node').length===4 && document.querySelectorAll('.react-flow__edge-call-definition .react-flow__edge-path').length===5 && !document.querySelector('.svg-export>button').disabled`);
        const geometry = () => evaluate(`(()=>{
            const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,start:Number(n.dataset.sourceStart)}};
            return {calls:[...document.querySelectorAll('.call-node')].map(rect),inputs:[...document.querySelectorAll('.io-input')].map(rect),
                paths:[...document.querySelectorAll('.react-flow__edge-call-definition .react-flow__edge-path')].map(p=>p.getAttribute('d'))};})()`);
        const initial = await geometry(), [top, left, right, done] = initial.calls;
        assert.equal(top.y, left.y); assert.equal(left.x, right.x);
        assert(right.y > left.y + left.h); assert(left.x > top.x + top.w);
        assert(done.y > right.y + right.h);
        for (const input of initial.inputs) {
            const card = initial.calls.find(c => c.start === input.start);
            assert(Math.abs(card.x + card.w - input.x - input.w - 10) <= 1, 'Input stays at the card right padding');
        }
        assert(initial.paths.some(d => d.includes('Q')), 'paths bend between vertically offset slots');
        const routing = await evaluate(`(()=>{
            const cards=[...document.querySelectorAll('.call-node')].map(n=>n.getBoundingClientRect());
            let horizontal=0, collisions=0;
            for(const path of document.querySelectorAll('.react-flow__edge-execution .react-flow__edge-path')) {
                const matrix=path.getScreenCTM(), length=path.getTotalLength();
                const point=t=>{const p=path.getPointAtLength(t);return new DOMPoint(p.x,p.y).matrixTransform(matrix)};
                let previous=point(0);
                for(let t=1;t<=length;t++) {
                    const p=point(t);
                    if(Math.abs(p.y-previous.y)<0.01 && Math.abs(p.x-previous.x)>0.1) {
                        horizontal++;
                        if(cards.some(r=>p.x>r.left+1 && p.x<r.right-1 && p.y>r.top+1 && p.y<r.bottom-1)) collisions++;
                    }
                    previous=p;
                }
            }
            return {horizontal,collisions};
        })()`);
        assert(routing.horizontal > 0, 'independently centred statements require horizontal execution segments');
        assert.equal(routing.collisions, 0, 'horizontal execution segments clear the complete call subtree');
        await call('Emulation.setDeviceMetricsOverride', {width:320,height:700,deviceScaleFactor:1,mobile:false});
        await new Promise(resolve => setTimeout(resolve, 500));
        await until(`!document.querySelector('.svg-export>button').disabled`);
        const before = await geometry(), first = before.calls[0];
        const hit = {x:first.x+first.w-32,y:first.y+15};
        await call('Input.dispatchMouseEvent', {type:'mousePressed',...hit,button:'left',clickCount:1});
        for (const dx of [10, 50, 100]) await call('Input.dispatchMouseEvent', {type:'mouseMoved',x:hit.x-dx,y:hit.y,buttons:1});
        await call('Input.dispatchMouseEvent', {type:'mouseReleased',x:hit.x-100,y:hit.y,button:'left',clickCount:1});
        await new Promise(resolve => setTimeout(resolve, 800));
        const moved = await geometry(), dx = moved.calls[0].x - before.calls[0].x;
        assert(dx < -20, `dragging a visible call moves its whole tree: ${JSON.stringify({hit,before,moved})}`);
        for (let i=1;i<3;i++) assert(Math.abs(moved.calls[i].x-before.calls[i].x-dx)<0.01);
        assert.equal(moved.calls[3].x, before.calls[3].x, 'the following statement stays fixed');
        assert.equal(moved.paths.length, 5);
        await evaluate(`document.querySelector('.svg-export>button').click()`);
        await evaluate(`document.querySelector('.svg-export-menu>button').click()`);
        await until('window.exports.length>0');
        const exported = await evaluate(`(()=>{const doc=new DOMParser().parseFromString(window.exports[0].svg,'image/svg+xml');return {error:!!doc.querySelector('parsererror'),text:doc.documentElement.textContent,edges:doc.querySelectorAll('[data-edge-id]').length,html:doc.querySelectorAll('foreignObject,image').length}})()`);
        assert(!exported.error); assert(exported.text.includes('a wider trailing label')); assert(exported.edges >= 7); assert.equal(exported.html, 0);
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

function precededCalls() {
    const reply = branchedCalls();
    const name = 'a_very_wide_preceding_procedure_with_a_long_display_name', prefix = name + '()\n';
    const shift = node => {
        node.start += prefix.length; node.end += prefix.length;
        for (const value of Object.values(node.fields ?? {})) for (const child of Array.isArray(value) ? value : [value]) shift(child);
    };
    shift(reply.root);
    const callNode = { kind: 'call', start: 0, end: prefix.length - 1, line: 1, column: 1,
        fields: { target: { kind: 'ident', start: 0, end: name.length, line: 1, column: 1 }, argument: [] },
        callable: { inputs: [], outputs: [] } };
    reply.root.fields.items.unshift({ ...callNode, kind: 'call-stmt', fields: { value: callNode }, callable: undefined });
    reply.root.start = 0;
    reply.source = prefix + reply.source;
    return reply;
}

test('left and right arrows share Shift-wheel scrolling of the hovered owner, not the focused node', { timeout: 60000 }, async () => {
    const reply = precededCalls();
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, call, errors }) => {
        await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 1600, deviceScaleFactor: 1, mobile: false });
        await until(`document.querySelectorAll('.call-tree-surface').length===3 && !document.querySelector('.svg-export>button').disabled`);
        const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const geometry = () => evaluate(`(()=>{
            const m=new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);
            return {x:[...document.querySelectorAll('.call-tree-surface')].map(n=>n.getBoundingClientRect().x),viewport:{x:m.e,y:m.f}};
        })()`);
        const hover = async index => {
            const point = await evaluate(`(()=>{const r=document.querySelectorAll('.call-tree-surface')[${index}].getBoundingClientRect();
                return {x:Math.max(10,Math.min(innerWidth-10,r.x+r.width/2)),y:r.y+2}})()`);
            await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
            return point;
        };
        const press = async key => {
            const code = key === 'ArrowRight' ? 39 : 37;
            for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code });
            await frame();
        };
        await evaluate(`document.querySelectorAll('.call-node')[4].closest('.react-flow__node').focus({preventScroll:true})`);
        await frame();
        const initial = await geometry();
        await hover(1);
        await press('ArrowRight');
        const right = await geometry();
        assert.deepEqual(right.x, [initial.x[0], initial.x[1]-24, initial.x[2]]);
        assert.deepEqual(right.viewport, initial.viewport);
        await press('ArrowLeft');
        assert.deepEqual(await geometry(), initial);
        const point = await hover(1);
        await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 100, modifiers: 8 });
        await frame();
        assert.deepEqual(await geometry(), right, 'one key press equals one Shift-wheel step');
        await hover(0);
        await press('ArrowRight');
        const switched = await geometry();
        assert.deepEqual(switched.x, [initial.x[0]-24, right.x[1], initial.x[2]]);
        await hover(2);
        await press('ArrowRight');
        assert.deepEqual(await geometry(), switched, 'a fitting hovered node does not scroll');
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 });
        await press('ArrowRight');
        assert.deepEqual(await geometry(), switched, 'leaving the graph forgets the previous hover target');
        await hover(1);
        await evaluate(`document.querySelector('textarea.literal-input').focus({preventScroll:true})`);
        await press('ArrowLeft');
        assert.deepEqual(await geometry(), switched, 'focused editors retain caret navigation');
        await evaluate(`document.activeElement.blur()`);
        const label = await evaluate(`(()=>{const n=[...document.querySelectorAll('.type-label')].find(n=>{
            const r=n.getBoundingClientRect();return r.x>0 && r.right<innerWidth && r.y>0 && r.bottom<innerHeight});
            const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...label });
        await press('ArrowRight');
        assert.deepEqual(await geometry(), switched, 'hovered type labels use the wheel exclusion too');
        for (let i=0;i<30;i++) { await hover(0); await press('ArrowRight'); }
        const limit = await geometry();
        await hover(0); await press('ArrowRight');
        assert.deepEqual(await geometry(), limit, 'horizontal bounds do not accumulate excess key input');
        await hover(0); await press('ArrowLeft');
        assert.equal((await geometry()).x[0], limit.x[0]+24, 'reversing from the limit moves immediately');
        assert.deepEqual((await geometry()).viewport, initial.viewport);
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('a fitting expression is centred as a whole and scrolls from a left-aligned frame in a narrower viewport', { timeout: 60000 }, async () => {
    const reply = precededCalls();
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, call, errors }) => {
        await until(`document.querySelectorAll('.call-tree-surface').length===3 && !document.querySelector('.svg-export>button').disabled`);
        const geometry = () => evaluate(`(()=>{
            const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
            return {frames:[...document.querySelectorAll('.call-tree-surface')].map(rect),calls:[...document.querySelectorAll('.call-node')].map(rect)};
        })()`);
        const initial = await geometry(), width = Math.ceil(initial.frames[1].w + 40);
        await call('Emulation.setDeviceMetricsOverride', { width, height: 1600, deviceScaleFactor: 1, mobile: false });
        await new Promise(resolve => setTimeout(resolve, 500));
        await until(`!document.querySelector('.svg-export>button').disabled`);
        const fitting = await geometry(), frame = fitting.frames[1];
        assert(frame.w < width - 16, 'the expression itself is narrower than the viewport');
        assert(Math.abs(frame.x - (width - frame.w) / 2) < 1, 'the complete expression has equal left and right margins');
        assert(frame.x + frame.w <= width - 8, 'the whole expression is visible without a gesture');
        await call('Emulation.setDeviceMetricsOverride', { width: Math.floor(frame.w - 100), height: 1600, deviceScaleFactor: 1, mobile: false });
        await new Promise(resolve => setTimeout(resolve, 500));
        await until(`!document.querySelector('.svg-export>button').disabled`);
        const before = await geometry(), leading = before.calls[1], child = before.calls[2];
        assert(Math.abs(before.frames[1].x - 8) < 1, 'oversized expressions use the same left margin');
        const hit = { x: (leading.x + leading.w + child.x) / 2, y: leading.y + 12 };
        assert(await evaluate(`document.elementFromPoint(${hit.x},${hit.y})?.classList.contains('call-tree-surface')`),
            'the empty gap between cards is a reading surface');
        await call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...hit, deltaX: 0, deltaY: 100, modifiers: 8 });
        await new Promise(resolve => setTimeout(resolve, 250));
        const wheeled = await geometry();
        assert(wheeled.frames[1].x < before.frames[1].x, 'Shift+wheel scrolls positioned overflow');
        hit.x += wheeled.frames[1].x - before.frames[1].x;
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...hit, button: 'left', clickCount: 1 });
        for (const dx of [10, 30, 60]) await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x - dx, y: hit.y, buttons: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x - 60, y: hit.y, button: 'left', clickCount: 1 });
        await new Promise(resolve => setTimeout(resolve, 800));
        const moved = await geometry();
        assert(moved.frames[1].x < wheeled.frames[1].x, 'dragging the empty frame scrolls the expression');
        assert.equal(moved.frames[0].x, before.frames[0].x);
        assert.equal(moved.frames[2].x, before.frames[2].x, 'other statements remain fixed');
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('fold buttons and native-menu messages toggle the same call without source edits or stale actions', { timeout: 60000 }, async () => {
    const reply = branchedCalls(), leftStart = reply.source.indexOf('left(');
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelectorAll('.call-node').length===4 && !document.querySelector('.svg-export>button').disabled`);
        const context = await evaluate(`JSON.parse(document.querySelector('.call-node[data-source-start="${leftStart}"]').dataset.vscodeContext)`);
        assert(context.lhatFoldable && context.lhatFoldKey);
        assert.equal(await evaluate(`document.querySelectorAll('.call-node > .foldbtn').length`), 4);
        assert(await evaluate(`[...document.querySelectorAll('.definitionhandle')].length>0`));
        const send = version => evaluate(`window.postMessage({type:'toggleFold',key:${JSON.stringify(context.lhatFoldKey)},version:${version}},'*')`);
        await send(0);
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert.equal(await evaluate(`document.querySelectorAll('.call-node').length`), 4, 'a stale menu cannot fold a new source version');
        await send(1);
        await until(`document.querySelector('.box.folded[data-source-start="${leftStart}"]') && !document.querySelector('.svg-export>button').disabled`);
        assert.equal(await evaluate(`document.querySelectorAll('.call-node').length`), 3);
        const foldedContext = await evaluate(`JSON.parse(document.querySelector('.box.folded[data-source-start="${leftStart}"]').dataset.vscodeContext)`);
        assert.equal(foldedContext.lhatFoldKey, context.lhatFoldKey);
        await evaluate(`document.querySelector('.box.folded[data-source-start="${leftStart}"] > .foldbtn').click()`);
        await until(`document.querySelectorAll('.call-node').length===4 && !document.querySelector('.svg-export>button').disabled`);
        await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Fold All').click()`);
        await until(`document.querySelectorAll('.box.folded').length===2 && !document.querySelector('.svg-export>button').disabled`);
        assert.equal(await evaluate(`document.querySelectorAll('.call-node').length`), 0);
        await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All').click()`);
        await until(`document.querySelectorAll('.call-node').length===4 && !document.querySelector('.svg-export>button').disabled`);
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('conditional frames render real expression nodes, expose bilingual titles and fold independently', { timeout: 60000 }, async () => {
    const reply = conditionalExpressions();
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelectorAll('.condition-node').length===2 && !document.querySelector('.svg-export>button').disabled`);
        assert.equal(await evaluate(`document.querySelectorAll('.condition-node.folded .fold-summary').length`), 2);
        await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All').click()`);
        await until(`!document.querySelector('.condition-node.folded') && !document.querySelector('.svg-export>button').disabled`);
        const titles = () => evaluate(`[...document.querySelectorAll('.box > .boxlabel')].map(n=>n.textContent)`);
        const japanese = await titles();
        assert(japanese.includes('条件分岐') && japanese.includes('条件選択'));
        assert.equal(japanese.filter(t => t === '条件').length, 2);
        const callCount = await evaluate(`document.querySelectorAll('.call-node').length`);
        assert.equal(callCount, 2, 'only the nested call and body call use call cards');
        assert.equal(await evaluate(`document.querySelectorAll('.operator-expression').length`), 2);
        const visible = await evaluate(`(()=>{
            const frame=document.querySelector('.condition-node'), r=frame.getBoundingClientRect();
            const card=[...document.querySelectorAll('.call-node')].find(n=>{
                const c=n.getBoundingClientRect();return c.left>r.left && c.right<r.right && c.top>r.top && c.bottom<r.bottom;
            });
            if(!card)return false;
            const c=card.getBoundingClientRect();return card.contains(document.elementFromPoint(c.left+8,c.top+8));
        })()`);
        assert(visible, 'the opaque condition frame does not cover its expression children');
        await evaluate(`document.querySelector('.condition-node > .foldbtn').click()`);
        await until(`document.querySelector('.condition-node.folded') && !document.querySelector('.svg-export>button').disabled`);
        assert.equal(await evaluate(`document.querySelectorAll('.call-node').length`), 1, 'only this condition subtree is hidden');
        const preview = await evaluate(`(()=>{
            const box=document.querySelector('.condition-node.folded'), title=box.querySelector('.boxlabel'), summary=box.querySelector('.fold-summary');
            const a=title.getBoundingClientRect(), b=summary.getBoundingClientRect(), r=box.getBoundingClientRect();
            return {title:title.textContent, text:summary.textContent, below:b.top>=a.bottom, inside:b.bottom<=r.bottom};
        })()`);
        assert.deepEqual(preview, {title:'条件', text:'check(value) = 1', below:true, inside:true});
        await evaluate(`document.querySelector('.svg-export>button').click()`);
        await evaluate(`document.querySelector('.svg-export-menu>button').click()`);
        await until('window.exports.length>0');
        const exportedText = await evaluate(`new DOMParser().parseFromString(window.exports.at(-1).svg,'image/svg+xml').documentElement.textContent`);
        assert(exportedText.includes('check(value) = 1'), 'SVG contains the collapsed source preview');
        await evaluate(`document.querySelector('.condition-node.folded > .foldbtn').click()`);
        await until(`document.querySelectorAll('.call-node').length===2 && !document.querySelector('.svg-export>button').disabled`);
        await evaluate(`window.postMessage({type:'localization',language:'en'},'*')`);
        await until(`[...document.querySelectorAll('.boxlabel')].some(n=>n.textContent==='Conditional Selection') && !document.querySelector('.svg-export>button').disabled`);
        const english = await titles();
        assert(english.includes('Conditional Branch'));
        assert.equal(english.filter(t => t === 'Condition').length, 2);
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('an unmatched IF has a visible outer route and completed arms join the statement footer', { timeout: 60000 }, async () => {
    await browser({ ...routes, '/': { type: 'text/html', body: html(branchFlow()) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelector('.react-flow__edge-execution-bypass .react-flow__edge-path') && !document.querySelector('.svg-export>button').disabled`);
        const route = await evaluate(`(()=>{
            const path=document.querySelector('.react-flow__edge-execution-bypass .react-flow__edge-path');
            const cards=[...document.querySelectorAll('.condition-node,.call-node')].map(n=>n.getBoundingClientRect());
            const matrix=path.getScreenCTM(); let maxX=-Infinity,collisions=0;
            for(let t=0;t<=path.getTotalLength();t+=2){
                const p=path.getPointAtLength(t),screen=new DOMPoint(p.x,p.y).matrixTransform(matrix);
                maxX=Math.max(maxX,screen.x);
                if(cards.some(r=>screen.x>r.left+1 && screen.x<r.right-1 && screen.y>r.top+1 && screen.y<r.bottom-1))collisions++;
            }
            return {collisions, maxX, right:Math.max(...cards.map(r=>r.right)),
                merges:document.querySelectorAll('.react-flow__edge[data-id*="__merge__"] .react-flow__edge-path').length,
                appendInputs:document.querySelectorAll('.react-flow__node:has(.add-node) [data-handleid="flow-in"]').length};
        })()`);
        assert.equal(route.collisions, 0);
        assert(route.maxX > route.right, 'the no-match route passes to the right of all condition and body nodes');
        assert.equal(route.merges, 1);
        assert.equal(route.appendInputs, 2, 'body and outer statement-list footers both accept execution lines');
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('an empty document draws a start-to-add arrow', { timeout: 60000 }, async () => {
    const reply = { source: '', root: { kind: 'block', start: 0, end: 0, line: 1, column: 1 } };
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelector('.react-flow__edge-execution .react-flow__edge-path') && !document.querySelector('.svg-export>button').disabled`);
        assert.equal(await evaluate(`document.querySelectorAll('.react-flow__edge-path').length`), 1);
        assert(await evaluate(`!!document.querySelector('.react-flow__edge-path').getAttribute('marker-end')`));
        assert(await evaluate(`!!document.querySelector('.react-flow__node:has(.add-node) [data-handleid="flow-in"]')`));
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('terminal statements have incoming paths but no outgoing handles, merge wires or statement footers', { timeout: 60000 }, async () => {
    for (const panic of [false, true]) {
        const reply = terminalFlow({ panic, branch: 'all', trailing: true });
        await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, errors }) => {
            await until(`document.querySelector('.svg-export>button') && !document.querySelector('.svg-export>button').disabled`);
            await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All').click()`);
            await until(`document.querySelectorAll('.condition-node').length===1 && !document.querySelector('.svg-export>button').disabled`);
            const geometry = await evaluate(`(()=>{
                const boxes=[...document.querySelectorAll('.react-flow__node')].filter(n=>{
                    const box=n.querySelector('.box[data-source-start]');
                    if(!box)return false;
                    return ${JSON.stringify(reply.source)}.slice(Number(box.dataset.sourceStart),Number(box.dataset.sourceEnd)).startsWith(${JSON.stringify(panic ? 'panic^' : 'return^')}) &&
                        (box.classList.contains('return-node') || box.querySelector(':scope > .boxlabel [data-role="panic"]') || (!box.classList.contains('container') && !box.classList.contains('condition-node')));
                });
                const after=[...document.querySelectorAll('.call-node')].find(n=>Number(n.dataset.sourceStart)===${reply.source.indexOf('print')});
                return {terminals:boxes.length, inputs:boxes.filter(n=>n.querySelector('[data-handleid="flow-in"]')).length,
                    outputs:boxes.filter(n=>n.querySelector('[data-handleid="flow-out"]')).length,
                    footers:document.querySelectorAll('.react-flow__node:has(.add-node) [data-handleid="flow-in"]').length,
                    merges:document.querySelectorAll('.react-flow__edge[data-id*="__merge__"]').length,
                    bypass:document.querySelectorAll('.react-flow__edge-execution-bypass').length,
                    afterVisible:!!after, afterHandles:after?.parentElement.querySelectorAll('.flowhandle').length};
            })()`);
            assert.equal(geometry.terminals, 2);
            assert.equal(geometry.inputs, 2);
            assert.equal(geometry.outputs, 0);
            assert.equal(geometry.footers, 0);
            assert.equal(geometry.merges, 0);
            assert.equal(geometry.bypass, 0);
            assert(geometry.afterVisible, 'unreachable source is still displayed');
            assert.equal(geometry.afterHandles, 0);
            assert.equal(errors.length, 0, JSON.stringify(errors));
        });
    }
});

test('pattern frames show expression trees in horizontal statement arms and vertical expression alternatives', { timeout: 60000 }, async () => {
    for (const expression of [false, true]) {
        const reply = patternMatching({ expression });
        await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, errors }) => {
            await until(`document.querySelectorAll('.condition-node').length===2 && !document.querySelector('.svg-export>button').disabled`);
            assert.equal(await evaluate(`document.querySelectorAll('.condition-node.folded .fold-summary').length`), 2);
            await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All').click()`);
            await until(`!document.querySelector('.condition-node.folded') && !document.querySelector('.svg-export>button').disabled`);
            const geometry = () => evaluate(`(()=>{
                const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
                const frames=[...document.querySelectorAll('.condition-node')];
                return {frames:frames.map(rect),labels:frames.map(n=>n.querySelector('.boxlabel').textContent),
                    calls:[...document.querySelectorAll('.call-node')].map(rect),
                    titles:[...document.querySelectorAll('.boxlabel')].map(n=>n.textContent)};
            })()`);
            const initial = await geometry(), [first, second] = initial.frames;
            assert.deepEqual(initial.labels, ['パターン', 'パターン']);
            assert(initial.titles.includes(expression ? 'パターン選択' : 'パターン分岐'));
            assert(expression ? second.y >= first.y + first.h : second.x >= first.x + first.w,
                'candidate ordering follows the requested orientation');
            assert.equal(initial.calls.filter(c => c.x > first.x && c.x + c.w < first.x + first.w &&
                c.y > first.y && c.y + c.h < first.y + first.h).length, 1, 'the first pattern contains one nested call');
            await evaluate(`document.querySelector('.condition-node > .foldbtn').click()`);
            await until(`document.querySelector('.condition-node.folded') && !document.querySelector('.svg-export>button').disabled`);
            const folded = await geometry();
            assert.equal(folded.calls.length, initial.calls.length - 1);
            assert.equal(await evaluate(`document.querySelector('.condition-node.folded .fold-summary').textContent`), 'threshold(1) + 2');
            assert.equal(await evaluate(`document.querySelector('.condition-node.folded .boxlabel').textContent`), 'パターン');
            await evaluate(`document.querySelector('.condition-node.folded > .foldbtn').click()`);
            await until(`document.querySelectorAll('.call-node').length===${initial.calls.length} && !document.querySelector('.svg-export>button').disabled`);
            await evaluate(`window.postMessage({type:'localization',language:'en'},'*')`);
            await until(`[...document.querySelectorAll('.boxlabel')].some(n=>n.textContent===${JSON.stringify(expression ? 'Pattern Matching Selection' : 'Pattern Matching Branch')}) && !document.querySelector('.svg-export>button').disabled`);
            assert.deepEqual((await geometry()).labels, ['Pattern', 'Pattern']);
            assert.equal(errors.length, 0, JSON.stringify(errors));
        });
    }
});

test('ArrowUp and ArrowDown scroll by line, PageUp and PageDown by page, preserving editor and menu keys', { timeout: 60000 }, async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `print("row ${i}")`), source = lines.join('\n');
    let offset = 0;
    const items = lines.map((text, i) => {
        const start = offset; offset += text.length + 1;
        const node = (kind, from, end) => ({ kind, start: from, end, line: i + 1, column: from - start + 1 });
        const value = { ...node('call', start, start + text.length),
            fields: { target: node('ident', start, start + 5), argument: [node('string', start + 6, start + text.length - 1)] },
            callable: { inputs: [{ name: 'value', type: 'string^' }], outputs: [] } };
        return { ...node('call-stmt', start, start + text.length), fields: { value } };
    });
    const reply = { source, root: { kind: 'block', start: 0, end: source.length, line: 1, column: 1, fields: { items } } };
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, call, errors }) => {
        await until(`document.querySelectorAll('.call-node').length===12 && !document.querySelector('.svg-export>button').disabled`);
        const position = () => evaluate(`(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);return {x:m.e,y:m.f}})()`);
        const page = async key => {
            const code = { PageDown: 34, PageUp: 33, ArrowDown: 40, ArrowUp: 38 }[key];
            await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code });
            await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
            await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        };
        const initial = await position(), height = await evaluate(`document.getElementById('flow').clientHeight`);
        await page('ArrowUp');
        assert.deepEqual(await position(), initial, 'ArrowUp stays at the top');
        await page('ArrowDown');
        assert.deepEqual(await position(), { x: initial.x, y: initial.y - 16 });
        await page('ArrowUp');
        assert.deepEqual(await position(), initial);
        const nodePosition = await evaluate(`(()=>{const n=document.querySelector('.call-node').closest('.react-flow__node');n.focus({preventScroll:true});return n.style.transform})()`);
        await page('ArrowDown');
        assert.deepEqual(await position(), { x: initial.x, y: initial.y - 16 }, 'arrows also scroll when a graph node has focus');
        assert.equal(await evaluate(`document.querySelector('.call-node').closest('.react-flow__node').style.transform`), nodePosition);
        await page('ArrowUp');
        await page('PageDown');
        const down = await position();
        assert.equal(down.x, initial.x);
        assert(Math.abs(down.y - (initial.y - height * 0.9)) < 1);
        await page('PageUp');
        assert.deepEqual(await position(), initial);
        await page('PageUp');
        assert.deepEqual(await position(), initial, 'PageUp stays at the top');
        for (let i = 0; i < 12; i++) await page('PageDown');
        const bottom = await position();
        await page('PageDown');
        assert.deepEqual(await position(), bottom, 'PageDown stays at the bottom');
        await page('ArrowDown');
        assert.deepEqual(await position(), bottom, 'ArrowDown stays at the bottom');
        for (let i = 0; i < 12; i++) await page('PageUp');
        assert.deepEqual(await position(), initial);
        await evaluate(`document.querySelector('.literal-editor textarea').focus({preventScroll:true})`);
        await page('PageDown');
        await page('ArrowDown');
        assert.deepEqual(await position(), initial, 'literal editing keeps its keyboard behavior');
        await evaluate(`document.activeElement.blur();document.querySelector('.svg-export>button').click()`);
        await until(`!!document.querySelector('.svg-export-menu')`);
        await evaluate(`document.querySelector('.svg-export-menu>button').focus({preventScroll:true})`);
        await page('PageDown');
        await page('ArrowDown');
        assert.deepEqual(await position(), initial, 'menu navigation does not scroll the graph');
        await evaluate(`document.activeElement.blur();document.querySelector('.svg-export>button').click();[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='A+').click()`);
        await until(`document.querySelector('#flow').style.getPropertyValue('--lhat-scale')!=='1' && !document.querySelector('.svg-export>button').disabled`);
        const enlarged = await position(), scale = await evaluate(`Number(document.querySelector('#flow').style.getPropertyValue('--lhat-scale'))`);
        await page('ArrowDown');
        const scrolled = await position();
        assert.equal(scrolled.x, enlarged.x);
        assert(Math.abs(scrolled.y - (enlarged.y - 16 * scale)) < 0.01, 'line scrolling follows the text size');
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('reassignment pairs render in vertical rows with matching definition wires and translated operation titles', { timeout: 60000 }, async () => {
    for (const [operator, japanese, english] of [
        [':=', '再代入', 'Reassignment'], ['+=', '加算再代入', 'Addition Assignment'],
        ['?*=', '乗算再代入（nilチェック付き）', 'Multiplication Assignment (nil-checked)'],
    ]) {
        const reply = assignment(operator, { lowered: true });
        await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, errors }) => {
            await until(`document.querySelectorAll('.react-flow__edge.definition .react-flow__edge-path').length===2 && !document.querySelector('.svg-export>button').disabled`);
            const geometry = await evaluate(`(()=>{
                const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
                const targets=[...document.querySelectorAll('.react-flow__node:has([data-handleid="definition-in"])')].map(rect);
                const values=[...document.querySelectorAll('.literal-number')].map(n=>({...rect(n),value:n.querySelector('input').value}));
                const lines=[...document.querySelectorAll('.react-flow__edge.definition .react-flow__edge-path')].map(p=>{
                    const a=p.getPointAtLength(0),b=p.getPointAtLength(p.getTotalLength()),m=p.getScreenCTM();
                    const from=new DOMPoint(a.x,a.y).matrixTransform(m),to=new DOMPoint(b.x,b.y).matrixTransform(m);
                    return {sx:from.x,sy:from.y,tx:to.x,ty:to.y};
                });
                return {title:document.querySelector('[data-role="reassignment"]').textContent,targets,values,lines,calls:document.querySelectorAll('.call-node').length};
            })()`);
            assert.equal(geometry.title, japanese);
            assert.equal(geometry.calls, 0, 'the compiler-generated compound tree is absent');
            assert.equal(geometry.targets.length, 2); assert.equal(geometry.values.length, 2);
            assert(geometry.targets[1].y > geometry.targets[0].y + geometry.targets[0].h);
            for (let i = 0; i < 2; i++) {
                const target = geometry.targets[i], value = geometry.values[i], line = geometry.lines[i];
                assert.equal(value.value, String(i + 1));
                assert(value.x > target.x + target.w);
                assert(Math.abs(line.sy - line.ty) < 1 && line.sx > line.tx, 'the value connects to the corresponding target');
                assert(line.ty > target.y && line.ty < target.y + target.h);
            }
            await evaluate(`window.postMessage({type:'localization',language:'en'},'*')`);
            await until(`document.querySelector('[data-role="reassignment"]')?.textContent===${JSON.stringify(english)} && !document.querySelector('.svg-export>button').disabled`);
            assert.equal(errors.length, 0, JSON.stringify(errors));
        });
    }
});


test('annotation argument menus construct names, binary strings and variadic lists through live source edits', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, load } = require('./graph-browser-host.cjs'), api = load('graphAnnotations.ts');
    const catalog = api.parseAnnotationCatalog({ annotations: [
        { name: 'args', targets: { binding: true }, signature: 'f^string^, ...;' },
        { name: 'fixed', targets: { binding: true }, signature: 'f^number^, string^;' },
        { name: 'marker', targets: { binding: true }, signature: 'f^;' },
        { name: 'free', targets: { binding: true }, signature: 'f^...;' },
        { name: 'unknown', targets: { binding: true } },
    ] });
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(async source => ({ ...await parse(source), annotationChoices: catalog }), server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const { evaluate, until, call } = client, ui = await graphUi(host, client);
            const owner = () => host.tree.root.fields.items.at(-1);
            const site = () => api.annotationOwners(host.tree).find(o => o.kind === 'define').annotations[0];
            await ui.add('module'); await ui.add('let');
            await evaluate(`document.querySelector('.box[data-source-start="${owner().start}"][data-source-end="${owner().end}"]').parentElement.querySelector('.add-annotation').click()`);
            await ui.annotation(owner(), 'args');
            await ui.annotationArgument(site(), 0, 'name');
            await ui.input('.annotation-arguments', '🚀');
            assert.equal(site().text, '@args(🚀)');
            await ui.annotationArgument(site(), 0, 'string');
            assert.equal(site().text, '@args("🚀")');
            await ui.annotationArgument(site(), 0, 'name');
            await ui.input('.annotation-arguments', '`quoted name`');
            assert.equal(site().text, '@args(`quoted name`)');
            for (const [action, value] of [['true','true^'],['false','false^'],['nil','nil^'],['number','0']]) {
                await ui.annotationArgument(site(), 0, action);
                assert.equal(site().text, `@args(${value})`);
            }
            const beforeInvalid = await evaluate('window.edits.length');
            await evaluate(`document.querySelector('.annotation-arguments').focus();document.querySelector('.annotation-arguments').select()`);
            await call('Input.insertText', { text: '1_' });
            await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await until(`document.querySelector('.annotation-arguments[aria-invalid="true"]')`);
            assert.equal(await evaluate('window.edits.length'), beforeInvalid);
            await evaluate(`document.querySelector('.annotation-arguments').focus()`);
            await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await ui.input('.annotation-arguments', '-2.5e3');
            await ui.annotationArgument(site(), 0, String.raw`escapes:\xFF\x00`);
            assert.equal(site().text, String.raw`@args("\xFF\x00")`);
            assert(await evaluate(`!!document.querySelector('.annotation-parameter .literal-string')`));
            await ui.input('.annotation-arguments', String.raw`\x80\x00`);
            assert.equal(site().text, String.raw`@args("\x80\x00")`);
            await ui.annotationArgument(site(), 0, 'string');
            assert.equal(site().text, String.raw`@args("\x80\x00")`);
            await ui.annotationArgument(site(), 0, 'escapes:safe');
            assert.equal(site().text, '@args("safe")');
            await ui.annotationArgument(site(), undefined, 'name');
            await ui.input('.annotation-arguments', 'é', 1);
            await ui.annotationArgument(site(), undefined, 'number');
            await ui.input('.annotation-arguments', '7', 2);
            await ui.annotationArgument(site(), undefined, 'string');
            await ui.input('.annotation-arguments', 'a,b', 3);
            await ui.annotationArgument(site(), 3, 'raw');
            assert(api.annotationArgumentSpans(site().text)[3].text.startsWith("'"));
            await ui.input('.annotation-arguments', "c'd", 3);
            assert.equal(api.annotationArgumentSpans(site().text)[3].text, "'c''d'");
            await ui.annotationArgument(site(), 3, 'line');
            await ui.input('.annotation-arguments', 'line,)text', 3);
            assert.equal(api.annotationArgumentSpans(site().text)[3].text, '"""line,)text');
            await ui.annotationArgument(site(), undefined, 'nil');
            assert.equal(api.annotationArgumentSpans(site().text).length, 5);
            await ui.annotationArgument(site(), 4, 'delete');
            await ui.annotationArgument(site(), 3, 'quoted');
            await ui.input('.annotation-arguments', 'a,b', 3);
            assert.deepEqual(api.annotationArgumentSpans(site().text).map(a => a.text), ['"safe"','é','7','"a,b"']);
            const svg = (await svgTexts(client)).join(' ');
            for (const value of ['safe', 'é', '7', 'a,b']) assert(svg.includes(value), value);
            const addGeometry = await evaluate(`(()=>{const add=document.querySelector('.annotation-argument-add button').getBoundingClientRect(),other=document.querySelector('.annotation-add').getBoundingClientRect(),box=document.querySelector('.annotation-box').getBoundingClientRect();return {width:add.width,height:add.height,other:other.width,right:add.right,boxRight:box.right}})()`);
            assert(Math.abs(addGeometry.width-addGeometry.other)<0.1 && Math.abs(addGeometry.height-addGeometry.width)<0.1, JSON.stringify(addGeometry));
            assert(addGeometry.width < 20 && addGeometry.right < addGeometry.boxRight, JSON.stringify(addGeometry));
            if (process.env.LHAT_TEST_ARGUMENT_SCREENSHOT) fs.writeFileSync(process.env.LHAT_TEST_ARGUMENT_SCREENSHOT,
                Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
            await ui.annotationArgument(site(), 1, 'delete');
            assert.deepEqual(api.annotationArgumentSpans(site().text).map(a => a.text), ['"safe"','7','"a,b"']);
            await ui.annotationArgument(site(), 2, 'delete'); await ui.annotationArgument(site(), 1, 'delete');
            assert.deepEqual(api.annotationArgumentSpans(site().text).map(a => a.text), ['"safe"']);
            const required = async index => {
                await evaluate(`document.querySelector('.annotation-parameter[data-argument-index="${index}"] .structure-edit').click()`);
                await until(`document.querySelector('.statement-menu [role=option]')`);
                assert(!await evaluate(`[...document.querySelectorAll('.statement-menu [role=option]')].some(e=>e.textContent.includes('引数を削除'))`));
                await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            };
            await required(0);
            await ui.annotation(owner(), 'fixed', 'args');
            assert.equal(await evaluate(`document.querySelector('.annotation-argument-add')`), null);
            await required(0); await required(1);
            await ui.annotation(owner(), 'marker', 'fixed');
            assert.equal(site().text, '@marker');
            assert.equal(await evaluate(`document.querySelector('.annotation-argument-add')`), null);
            await ui.annotation(owner(), 'unknown', 'marker');
            await ui.annotationArgument(site(), undefined, 'string');
            await ui.annotationArgument(site(), 0, 'delete');
            assert.equal(site().text, '@unknown()');
            await ui.annotation(owner(), 'free', 'unknown');
            await ui.annotationArgument(site(), undefined, 'nil');
            await ui.annotationArgument(site(), 0, 'delete');
            assert.equal(site().text, '@free()');
            await ui.removeAnnotation(site());
            assert.equal(await evaluate(`document.querySelectorAll('.annotation-box').length`), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('Unicode annotations create, edit and delete through real source updates and survive semantic view changes', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, load } = require('./graph-browser-host.cjs');
    const api = load('graphAnnotations.ts');
    const catalog = api.parseAnnotationCatalog({ annotations: [
        { name: 'é', targets: { binding: true }, signature: 'f^number^, string^;' },
        { name: '🚀', targets: { binding: true }, signature: 'f^number^, string^;' },
        { name: '©', targets: { binding: true }, signature: 'f^;' },
    ] });
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(async source => ({ ...await parse(source), annotationChoices: catalog }), server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const { evaluate, until, call } = client, ui = await graphUi(host, client);
            const fn = () => host.tree.root.fields.items[0].fields.values[0];
            const owner = () => fn().fields.body.fields.items[0];
            const annotations = () => api.annotationOwners(host.tree).find(o => o.start === owner().start && o.end === owner().end).annotations;
            await ui.add('function');
            await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All').click()`);
            await until(`!document.querySelector('.svg-export>button').disabled`);
            await ui.add('let', fn().fields.body, fn().fields.body.fields.items[0]);
            const unchanged = host.tree.source;
            await evaluate(`document.querySelector('.box[data-source-start="${owner().start}"][data-source-end="${owner().end}"]').parentElement.querySelector('.add-annotation').click()`);
            await until(`document.querySelector('.annotation-add select') && !document.querySelector('.svg-export>button').disabled`);
            assert.equal(host.tree.source, unchanged);
            await ui.annotation(owner(), 'é');
            assert.equal(annotations()[0].text, '@é(0, "")');
            await ui.input('.annotation-arguments', '-2.5');
            await ui.input('.annotation-arguments', 'a,b', 1);
            await ui.annotation(owner(), '🚀', 'é');
            await ui.annotation(owner(), '©');
            assert.deepEqual(annotations().map(a => a.text), ['@🚀(-2.5, "a,b")', '@©']);
            const written = host.tree.source, edits = await evaluate('window.edits.length');
            const check = async () => {
                const texts = await svgTexts(client);
                for (const value of ['🚀', '©', '-2.5', 'a,b']) assert(texts.some(t => t.includes(value)), value);
                assert(!texts.some(t => t.includes('@🚀') || t.includes('@©')));
            };
            await check();
            await evaluate(`document.querySelector('.annotation-box .foldbtn').click()`);
            await until(`!document.querySelector('.annotation-row') && !document.querySelector('.svg-export>button').disabled`);
            assert((await svgTexts(client)).some(t => t.includes('アノテーション')));
            await evaluate(`document.querySelector('.annotation-box .foldbtn').click()`);
            await until(`document.querySelector('.annotation-row') && !document.querySelector('.svg-export>button').disabled`);
            await check();
            await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Fold All').click()`);
            await until(`document.querySelector('.box.folded') && !document.querySelector('.svg-export>button').disabled`);
            assert.equal(await evaluate(`document.querySelectorAll('.annotation-box').length`), 0, 'a folded callable hides its inner annotation owners');
            const point = await evaluate(`(()=>{const r=document.querySelector('.box.folded').getBoundingClientRect();return {x:r.left+8,y:r.top+8}})()`);
            for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
            await until(`document.querySelector('#trail') && !document.querySelector('.svg-export>button').disabled`);
            await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All').click()`);
            await until(`document.querySelector('.annotation-row') && !document.querySelector('.svg-export>button').disabled`);
            await check();
            assert.equal(host.tree.source, written);
            assert.equal(await evaluate('window.edits.length'), edits);
            await ui.removeAnnotation(annotations()[0]);
            assert.equal(annotations().length, 1);
            await ui.removeAnnotation(annotations()[0]);
            assert.equal(annotations().length, 0);
            assert.equal(await evaluate(`document.querySelectorAll('.annotation-box').length`), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('annotation sidebars group names without @ and support inline arguments, dropdown changes and additions', { timeout: 60000 }, async () => {
    const fixture = require('./annotation-fixture.cjs');
    let reply = fixture(), version = 1;
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, call, errors }) => {
        const ready = `!document.querySelector('.svg-export>button').disabled`;
        await until(`document.querySelectorAll('.annotation-box').length===2 && ${ready}`);
        const geometry = await evaluate(`(()=>{
            const side=document.querySelector('.annotation-box[data-source-start="${reply.source.indexOf('let^')}"]');
            const owner=document.querySelector('.box:not(.annotation-box)[data-source-start="${reply.source.indexOf('let^')}"]');
            const a=side.getBoundingClientRect(),b=owner.getBoundingClientRect();
            return {right:a.right,left:b.left,top:a.top,ownerTop:b.top,rows:side.querySelectorAll('.annotation-row').length,
                names:[...side.querySelectorAll('.annotation-name select')].map(s=>s.selectedOptions[0].textContent.trim())};
        })()`);
        assert(geometry.right < geometry.left, JSON.stringify(geometry));
        assert.equal(geometry.top, geometry.ownerTop);
        assert.equal(geometry.rows, 2); assert.deepEqual(geometry.names, ['range', 'label']);
        const appearance = await evaluate(`(()=>{const box=document.querySelector('.annotation-box'),header=box.querySelector('.annotation-header .semantic-label'),name=document.querySelector('.annotation-name select'),module=document.querySelector('.box:not(.annotation-box) .semantic-label[data-category="module"]');const c=document.createElement('canvas').getContext('2d');c.fillStyle=getComputedStyle(box).backgroundColor;c.fillRect(0,0,1,1);return {heading:header.textContent,color:getComputedStyle(header).color,moduleColor:getComputedStyle(module).color,nameColor:getComputedStyle(name).color,border:getComputedStyle(box).borderTopColor,alpha:c.getImageData(0,0,1,1).data[3]}})()`);
        assert.equal(appearance.heading, 'アノテーション'); assert.equal(appearance.color, appearance.moduleColor);
        assert.equal(appearance.nameColor, 'rgb(216, 205, 109)'); assert.equal(appearance.border, 'rgb(204, 167, 0)');
        assert(appearance.alpha > 0 && appearance.alpha < 255);
        const controls = await evaluate(`(()=>{const row=[...document.querySelectorAll('.annotation-row')].find(r=>r.querySelector('select').value==='range'),name=row.querySelector('select').getBoundingClientRect(),field=row.querySelector('.annotation-parameter').getBoundingClientRect(),add=row.closest('.annotation-box').querySelector('.annotation-add').getBoundingClientRect(),other=document.querySelector('.statement-button.floating-add').getBoundingClientRect(),numbers=[...row.querySelectorAll('.literal-number')],string=row.querySelector('.literal-string'),standard=[...document.querySelectorAll('.literal-number')].find(n=>!n.closest('.annotation-box'));return {gap:field.left-name.right,add:add.width,other:other.width,numbers:numbers.length,stringValue:string.querySelector('textarea').value,numberRadius:getComputedStyle(numbers[0]).borderRadius,standardRadius:getComputedStyle(standard).borderRadius,text:[...row.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('')}})()`);
        assert(controls.gap >= 0 && controls.gap < 8, JSON.stringify(controls));
        assert(Math.abs(controls.add - controls.other) < 0.01); assert.equal(controls.numbers, 2);
        assert.equal(controls.stringValue, 'a,b'); assert.equal(controls.numberRadius, controls.standardRadius);
        assert(!/[(),]/.test(controls.text));


        assert.equal(await evaluate(`document.querySelector('.annotation-editor')`), null);
        if (process.env.LHAT_TEST_SCREENSHOT) fs.writeFileSync(process.env.LHAT_TEST_SCREENSHOT,
            Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        await evaluate(`document.querySelector('.svg-export>button').click()`);
        await until(`document.querySelector('.svg-export-menu>button')`);
        await evaluate(`document.querySelector('.svg-export-menu>button').click()`);
        await until(`window.exports.length===1`);
        const exportedNames = await evaluate(`(()=>{const doc=new DOMParser().parseFromString(window.exports[0].svg,'image/svg+xml');return [...doc.querySelectorAll('text')].map(t=>t.textContent)})()`);
        assert(exportedNames.includes('range') && exportedNames.includes('label'));
        assert(!exportedNames.includes('game') && !exportedNames.includes('export_range'), 'export includes selected names, not hidden dropdown options');
        const setInput = async value => {
            await evaluate(`(()=>{const input=document.querySelector('.annotation-arguments');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        };
        const key = key => call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 27 });
        const refresh = async edit => {
            reply = fixture(reply.source.slice(0, edit.start) + edit.value + (edit.add ? '\n' : '') + reply.source.slice(edit.add ? edit.start : edit.end));
            version++;
            await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(reply)},uri:'file:///svg-example.lh',version:${version}},'*')`);
            await until(`document.querySelector('#app')?.dataset.graphVersion==='${version}' && ${ready} && document.querySelector('.annotation-box[data-source-start="${reply.source.indexOf('let^')}"][data-source-end="${reply.source.length}"]')`);
        };
        await setInput('call()'); await key('Enter');
        await until(`document.querySelector('.annotation-arguments').getAttribute('aria-invalid')==='true'`);
        assert.equal(await evaluate(`window.edits.length`), 0);
        await evaluate(`document.querySelector('.annotation-arguments').focus()`); await key('Escape');
        assert.equal(await evaluate(`document.querySelector('.annotation-arguments').value`), '0');
        await setInput('1'); await key('Enter');
        await until(`window.edits.length===1`);
        let edit = await evaluate(`window.edits[0]`);
        assert.equal(edit.value, '@range(1, 100, "a,b")'); assert.equal(edit.version, version);
        await refresh(edit);
        await evaluate(`(()=>{const input=document.querySelector('.annotation-parameters textarea');input.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'changed');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await key('Enter'); await until(`window.edits.length===2`);
        edit = await evaluate(`window.edits[1]`);
        assert.equal(edit.value, '@range(1, 100, "changed")'); await refresh(edit);
        await evaluate(`(()=>{const s=[...document.querySelectorAll('.annotation-name select')].find(s=>s.value==='range');s.value='game';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await until(`window.edits.length===3`); edit = await evaluate(`window.edits[2]`);
        assert.equal(edit.value, '@game'); await refresh(edit);
        await evaluate(`(()=>{const s=document.querySelector('.annotation-box[data-source-start="${reply.source.indexOf('let^')}"] .annotation-add select');s.value='export_range';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await until(`window.edits.length===4`); edit = await evaluate(`window.edits[3]`);
        assert.equal(edit.value, '@export_range(0, 0)'); assert.equal(edit.add, true); assert.equal(edit.ownerKind, 'define');
        await refresh(edit);
        await until(`document.querySelectorAll('.annotation-row').length===4 && ${ready}`);
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('.annotation-box[data-source-start="${reply.source.indexOf('let^')}"] .annotation-name select')].map(s=>s.value)`), ['game', 'label', 'export_range']);
        await evaluate(`document.querySelector('.annotation-box .foldbtn').click()`);
        await until(`document.querySelector('.annotation-box .foldbtn').getAttribute('aria-expanded')==='false' && ${ready}`);
        await evaluate(`document.querySelector('.annotation-row .annotation-delete').click()`);
        await until(`window.edits.length===5`);
        assert.equal(await evaluate(`window.edits[4].value`), '');
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('opening an empty annotation box is view-only and its footer selects the first source annotation', { timeout: 60000 }, async () => {
    const fixture = require('./annotation-fixture.cjs');
    const reply = fixture('@unit\nmodule^"demo"\nlet^ value = 1'), start = reply.source.indexOf('let^');
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, call, errors }) => {
        const ready = `!document.querySelector('.svg-export>button').disabled`;
        await until(`document.querySelector('.add-annotation') && ${ready}`);
        const context = await evaluate(`JSON.parse(document.querySelector('.add-annotation').parentElement.querySelector('.box').dataset.vscodeContext)`);
        assert.equal(context.lhatCanAddAnnotation, true);
        await evaluate(`window.postMessage({type:'showAnnotations',ownerStart:${start},ownerEnd:${reply.source.length},ownerKind:'define',version:1},'*')`);
        await until(`document.querySelector('.annotation-box[data-source-start="${start}"] .annotation-add select') && ${ready}`);
        assert.equal(await evaluate(`window.edits.length`), 0);
        assert.equal(await evaluate(`document.querySelector('.annotation-box[data-source-start="${start}"]').querySelectorAll('.annotation-row').length`), 0);
        assert.equal(await evaluate(`document.querySelectorAll('.annotation-hide').length`), 0);
        await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='A+').click()`);
        await until(`document.querySelector('#flow').style.getPropertyValue('--lhat-scale')!=='1' && ${ready}`);
        assert.equal(await evaluate(`document.querySelectorAll('.annotation-box').length`), 2);
        await evaluate(`(()=>{const s=document.querySelector('.annotation-box[data-source-start="${start}"] .annotation-add select');s.value='game';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await until(`window.edits.length===1`);
        const edit = await evaluate(`window.edits[0]`);
        assert.equal(edit.value, '@game'); assert.equal(edit.add, true);
        assert.equal(reply.source, '@unit\nmodule^"demo"\nlet^ value = 1');
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('unsaved annotation deletion refreshes candidates and disables the previous snapshot while checking', { timeout: 60000 }, async () => {
    const fixture = require('./annotation-fixture.cjs');
    const saved = fixture('@unit\nmodule^"demo"\n@game @export_class\nlet^ value = 1');
    const unsaved = fixture(saved.source.replace('@game @export_class\n', ''));
    await browser({ ...routes, '/': { type: 'text/html', body: html(saved) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelectorAll('.annotation-row').length===3 && !document.querySelector('.svg-export>button').disabled`);
        const compact = await evaluate(`(()=>{const box=document.querySelector('.annotation-box[data-source-start="${saved.source.indexOf('let^')}"]');return {width:box.getBoundingClientRect().width,gaps:[...box.querySelectorAll('.annotation-row')].map(row=>row.querySelector('.annotation-delete').getBoundingClientRect().left-row.querySelector('.annotation-name').getBoundingClientRect().right)}})()`);
        assert(compact.width < 150, JSON.stringify(compact)); assert(compact.gaps.every(gap=>gap >= 0 && gap < 8), JSON.stringify(compact));
        await evaluate(`window.postMessage({type:'pending'},'*')`);
        await until(`[...document.querySelectorAll('.annotation-picker select')].every(s=>s.disabled)`);
        assert.equal(await evaluate(`window.edits.length`), 0);
        await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(unsaved)},uri:'file:///svg-example.lh',version:2},'*')`);
        await until(`document.querySelector('.add-annotation') && !document.querySelector('.add-annotation').disabled && !document.querySelector('.svg-export>button').disabled`);
        await evaluate(`document.querySelector('.add-annotation').click()`);
        await until(`document.querySelector('.annotation-box[data-source-start="${unsaved.source.indexOf('let^')}"] .annotation-add select') && !document.querySelector('.svg-export>button').disabled`);
        const names = await evaluate(`[...document.querySelector('.annotation-box[data-source-start="${unsaved.source.indexOf('let^')}"] .annotation-add select').options].map(o=>o.value)`);
        assert(names.includes('game') && names.includes('export_class'));
        await evaluate(`(()=>{const s=document.querySelector('.annotation-box[data-source-start="${unsaved.source.indexOf('let^')}"] .annotation-add select');s.value='game';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await until(`window.edits.length===1`);
        assert.equal(await evaluate(`window.edits[0].version`), 2);
        assert.equal(await evaluate(`window.edits[0].value`), '@game');
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('individual annotation deletion updates the live text and removes its box only at zero entries', { timeout: 60000 }, async () => {
    const fixture = require('./annotation-fixture.cjs');
    const initial = fixture(), savedText = initial.source;
    let source = savedText, version = 1;
    const history = [], applied = [];
    await browser({ ...routes, '/': { type: 'text/html', body: html(initial, false) } }, async ({ evaluate, until, errors }) => {
        const document = { uri: 'file:live-annotations', get version() { return version; }, get isDirty() { return source !== savedText; },
            getText: () => source, positionAt: character => ({ line: 0, character }), save: () => { throw Error('must not save'); } };
        const vscode = { l10n: { t: text => text }, Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
            WorkspaceEdit: class { changes = []; replace(uri, range, text) { this.changes.push({ range, text }); } },
            workspace: { applyEdit: async edit => {
                history.push(source); applied.push(edit);
                for (const change of [...edit.changes].sort((a, b) => b.range.start.character - a.range.start.character))
                    source = source.slice(0, change.range.start.character) + change.text + source.slice(change.range.end.character);
                version++;
                await evaluate(`window.postMessage({type:'pending'},'*')`);
                return true;
            } } };
        const entry = path.resolve(__dirname, '../src/graphStatementEditor.ts'), mod = new (require('node:module'))(entry);
        mod.require = name => name === 'vscode' ? vscode : require(name);
        mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text, entry);
        const { editStatementFromGraph } = mod.exports;
        const ready = `!document.querySelector('.svg-export>button').disabled`;
        await until(`document.querySelectorAll('.annotation-box').length===2 && ${ready}`);
        for (const [index, name] of ['range', 'label'].entries()) {
            const tree = fixture(source), before = source;
            await evaluate(`[...document.querySelectorAll('.annotation-row')].find(row=>row.querySelector('select')?.value===${JSON.stringify(name)}).querySelector('.annotation-delete').click()`);
            await until(`window.edits.length===${index + 1}`);
            const message = await evaluate(`window.edits[${index}]`);
            assert.equal(message.type, 'editAnnotation'); assert.equal(message.value, '');
            assert.equal(source, before, 'clicking cannot remove the display before a successful text edit');
            assert.equal(await evaluate(`document.querySelectorAll('.annotation-box').length`), 2);
            await editStatementFromGraph(document, tree, message, undefined, () => true);
            assert.equal(applied.length, index + 1); assert.equal(applied[index].changes.length, 1);
            assert.equal(document.isDirty, true);
            assert(!source.includes(`@${name}`)); assert(source.includes('@unit') && source.includes('let^ value = 1'));
            const updated = fixture(source);
            await evaluate(`window.postMessage({type:'statementResult',id:${JSON.stringify(message.id)}},'*');window.postMessage({type:'tree',reply:${JSON.stringify(updated)},uri:'file:///svg-example.lh',version:${version}},'*')`);
            await until(`document.querySelectorAll('.annotation-row').length===${2 - index} && ${ready}`);
        }
        assert.equal(await evaluate(`document.querySelectorAll('.annotation-box').length`), 1, 'the empty declaration sidebar disappears');
        await evaluate(`document.querySelector('.add-annotation').click()`);
        await until(`document.querySelector('.annotation-box[data-source-start="${source.indexOf('let^')}"] .annotation-add select') && ${ready}`);
        assert.equal(await evaluate(`window.edits.length`), 2, 'opening the empty box must not edit source');
        const names = await evaluate(`[...document.querySelector('.annotation-box[data-source-start="${source.indexOf('let^')}"] .annotation-add select').options].map(o=>o.value)`);
        assert(names.includes('range') && names.includes('label'));
        await evaluate(`(()=>{const s=document.querySelector('.annotation-box[data-source-start="${source.indexOf('let^')}"] .annotation-add select');s.value='game';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await until(`window.edits.length===3`);
        const addition = await evaluate(`window.edits[2]`);
        await editStatementFromGraph(document, fixture(source), addition, undefined, () => true);
        assert.equal(applied.length, 3); assert(source.includes('@game')); assert(document.isDirty);
        await evaluate(`window.postMessage({type:'statementResult',id:${JSON.stringify(addition.id)}},'*');window.postMessage({type:'tree',reply:${JSON.stringify(fixture(source))},uri:'file:///svg-example.lh',version:${version}},'*')`);
        await until(`document.querySelectorAll('.annotation-row').length===2 && ${ready}`);
        for (const expectedRows of [1, 2, 3]) {
            source = history.pop(); version++;
            await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(fixture(source))},uri:'file:///svg-example.lh',version:${version}},'*')`);
            await until(`document.querySelectorAll('.annotation-row').length===${expectedRows} && ${ready}`);
            assert.equal(await evaluate(`document.querySelectorAll('.annotation-box').length`), expectedRows === 1 ? 1 : 2);
        }
        assert.equal(source, savedText); assert.equal(document.isDirty, false);
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});

test('a wide top-level definition keeps its annotation sidebar inside the viewport after resize and folding', { timeout: 60000 }, async () => {
    const base = branchedCalls(), prefix = 'module^"demo"\n@game @export_class\npublic^let^ Player = ';
    const shift = node => ({ ...node, start: node.start + prefix.length, end: node.end + prefix.length,
        ...(node.fields ? { fields: Object.fromEntries(Object.entries(node.fields).map(([key, value]) => [key, Array.isArray(value) ? value.map(shift) : shift(value)])) } : {}) });
    const callNode = shift(base.root.fields.items[0].fields.value); callNode.callable.outputs = ['number^'];
    const start = prefix.indexOf('public^'), source = prefix + base.source;
    const definition = { kind: 'define', start, end: callNode.end, line: 3, column: 1, fields: {
        targets: [{ kind: 'ident', start: prefix.indexOf('Player'), end: prefix.indexOf('Player') + 6, line: 3, column: 1 }], values: [callNode] } };
    const reply = { source, root: { kind: 'block', start: 0, end: source.length, line: 1, column: 1,
        fields: { items: [{ kind: 'module', start: 0, end: prefix.indexOf('\n'), line: 1, column: 1 }, definition, shift(base.root.fields.items[1])] } } };
    await browser({ ...routes, '/': { type: 'text/html', body: html(reply) } }, async ({ evaluate, until, call, errors }) => {
        const ready = `!document.querySelector('.svg-export>button').disabled`;
        const inspect = () => evaluate(`(()=>{const box=document.querySelector('.annotation-box[data-source-start="${start}"]'),r=box.getBoundingClientRect(),flow=document.querySelector('#flow').getBoundingClientRect(),owner=document.querySelector('.box:not(.annotation-box)[data-source-start="${start}"]').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,width:r.width,flowLeft:flow.left,flowRight:flow.right,ownerLeft:owner.left,ownerRight:owner.right}})()`);
        const check = async () => {
            const result = await inspect();
            assert(result.left >= result.flowLeft + 7, JSON.stringify(result));
            assert(result.right <= result.flowRight - 7, JSON.stringify(result));
            assert(result.ownerLeft > result.right, JSON.stringify(result));
        };
        for (const width of [500, 700, 1000]) {
            await call('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: false });
            await until(`document.querySelector('#flow')?.clientWidth===${width} && document.querySelector('.annotation-box[data-source-start="${start}"]') && ${ready}`);
            await new Promise(resolve => setTimeout(resolve, 250));
            await until(ready);
            await check();
            if (width === 500) {
                const result = await inspect();
                assert(result.ownerRight > result.flowRight, 'the regression fixture must contain an overflowing definition');
            }
        }
        await evaluate(`document.querySelector('.annotation-box .foldbtn').click()`);
        await until(`document.querySelector('.annotation-box .foldbtn').getAttribute('aria-expanded')==='false' && ${ready}`);
        await check();
        await evaluate(`document.querySelector('.annotation-box .foldbtn').click()`);
        await until(`document.querySelector('.annotation-box .foldbtn').getAttribute('aria-expanded')==='true' && ${ready}`);
        await check();
        assert.equal(errors.length, 0, JSON.stringify(errors));
    });
});


test('string escape menus create and edit binary bytes and preserve whitespace and empty input through live source changes', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse(String.raw`let^value="\xFF"`));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), binding = () => host.tree.root.fields.items[0], value = () => binding().fields.values[0];
            await ui.add('let');
            await ui.expression(value(), 'string');
            await ui.input('.literal-input', 'raw "quotes" \\ path');
            await ui.structure(value(), 'string:line');
            assert(host.tree.source.slice(value().start, value().end).startsWith('"""'));
            assert.equal(await client.evaluate(`document.querySelector('.literal-input').value`), 'raw "quotes" \\ path');
            await ui.structure(value(), 'string:quoted');
            await ui.structure(value(), String.raw`string:escapes:\xFF`);
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert(await client.evaluate(`document.querySelector('.box[data-source-start="${value().start}"][data-source-end="${value().end}"]').textContent.includes(${JSON.stringify(String.raw`\xFF`)})`));
            await ui.structure(value(), String.raw`string:escapes:\x80\x00`);
            assert.equal(host.tree.source.slice(value().start, value().end), String.raw`"\x80\x00"`);
            await ui.remove(binding());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            await ui.add('let');
            await ui.expression(value(), 'string');
            await ui.structure(value(), 'string:escapes:  keep  ');
            assert.equal(await client.evaluate(`document.querySelector('.literal-input').value`), '  keep  ');
            await ui.structure(value(), 'string:escapes:');
            assert.equal(await client.evaluate(`document.querySelector('.literal-input').value`), '');
            await ui.expression(value(), 'interpolation');
            const parts = () => value().fields.items;
            await ui.structure(parts()[0], String.raw`text:escapes:\xFF{{literal}}`);
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse(String.raw`let^value=$"\xFF{{literal}}{0}"`)));
            await ui.structure(parts()[0], 'text:escapes:  text  ');
            assert.equal(await client.evaluate(`document.querySelector('.interpolation-field.text textarea').value`), '  text  ');
            await ui.structure(parts()[0], 'text:escapes:');
            assert.equal(parts()[0].kind, 'interp-hole');
            await ui.remove(binding());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('literal, name and interpolation contents survive normal, folded and drilled SVG views', { timeout: 90000 }, async () => {
    const source = 'let^large=1234567890123456789\nlet^fraction=2.5e-3\nlet^text="日本語 & <quote>"\nlet^tag=id^`a.b`\nlet^outer=$large\nlet^value=large\nlet^formatted=$"prefix{1234567890123456789:%04d}middle{2.5e-3}suffix{"drilled text"}bytes{"\\xFF"}\\xFE"';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), interpolation = tree.root.fields.items.at(-1).fields.values[0];
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree, false) } }, async client => {
            const { evaluate, until, call } = client, ready = `document.querySelector('.svg-export>button') && !document.querySelector('.svg-export>button').disabled`;
            const capture = () => svgTexts(client);
            const normal = await capture();
            for (const text of ['1234567890123456789','2.5e-3','日本語 & <quote>','prefix','suffix','%04d']) assert(normal.includes(text), text + ': ' + normal.join('|'));
            assert(normal.some(text => text.includes('a.b')));
            assert(normal.some(text => text.includes(String.raw`\xFF`)));
            assert(normal.some(text => text.includes(String.raw`\xFE`)));
            assert(normal.join('').includes('$large'), normal.join('|'));
            await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Fold All').click()`);
            const folded = await capture();
            for (const text of ['1234567890123456789','2.5e-3','日本語 & <quote>']) assert(folded.includes(text), text);
            assert(folded.join('').includes('$"…"'), folded.join('|'));
            assert(folded.includes('formatted'));
            const selector = `.box.folded[data-source-start="${interpolation.start}"][data-source-end="${interpolation.end}"]`;
            await until(`document.querySelector(${JSON.stringify(selector)}) && ${ready}`);
            const target = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left,y:r.top}})()`);
            await call('Input.dispatchMouseEvent', { type:'mouseWheel', x:500, y:350, deltaY:target.y - 160, deltaX:target.x < 0 || target.x > 900 ? target.x - 200 : 0 });
            await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
            const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+8,y:r.top+8}})()`);
            for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent', { type, ...point, button:'left', clickCount:1 });
            await until(`document.querySelector('#trail') && ${ready}`);
            const drilled = await capture();
            for (const text of ['prefix','middle','suffix','%04d','1234567890123456789','2.5e-3','drilled text']) assert(drilled.includes(text), text + ': ' + drilled.join('|'));
            assert(drilled.some(text => text.includes(String.raw`\xFF`)));
            assert(drilled.some(text => text.includes(String.raw`\xFE`)));
            assert(!drilled.includes('日本語 & <quote>'));
            assert.equal(await evaluate('window.edits.length'), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('interpolation text and formatted holes delete through live controls and empty interpolation remains editable', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^value=$"left{(0+0):%04d}"'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), binding = () => host.tree.root.fields.items[0];
            const value = () => binding().fields.values[0], parts = () => value().fields?.items ?? [];
            await ui.add('let');
            await ui.expression(value(), 'interpolation');
            await ui.input('.interpolation-field.text textarea', 'left');
            await ui.expression(parts()[1].fields.value, 'add');
            await ui.input('.interpolation-field.format textarea', '%04d');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.remove(parts()[1]);
            assert.equal(parts().length, 1);
            assert.equal(await client.evaluate(`document.querySelector('.interpolation-field.text textarea').value`), 'left');
            await ui.remove(parts()[0]);
            assert.equal(parts().length, 0);
            assert.match(host.tree.source, /\$""/);
            await ui.interpolationPart(value(), 'expression');
            await ui.expression(parts()[0].fields.value, 'number');
            await ui.input(`.box[data-source-start="${parts()[0].fields.value.start}"] .literal-input`, '2.5e-3');
            assert.equal(parts()[0].fields.value.kind, 'float');
            await ui.interpolationPart(value(), 'text');
            await ui.input('.interpolation-field.text textarea', 'tail {literal}');
            await ui.remove(parts()[0]);
            assert.equal(await client.evaluate(`document.querySelector('.interpolation-field.text textarea').value`), 'tail {literal}');
            await ui.remove(binding());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('ordinary literal inputs commit source values and redraw after the live document changes', { timeout: 60000 }, async () => {
    const fixture = source => {
        const at = source.indexOf('=') + 2;
        const n = (kind, start, end, fields) => ({ kind, start, end, line: 1, column: start + 1, fields });
        return { source, root: n('block', 0, source.length, { items: [n('define', 0, source.length, {
            targets: [n('ident', 5, 10)], values: [n(source[at] === '"' ? 'string' : 'int', at, source.length)] })] }) };
    };
    await browser({ ...routes, '/': { type: 'text/html', body: html(fixture('let^ value = 1'), false) } }, async ({ evaluate, until, call, errors }) => {
        let text = 'let^ value = 1', version = 1;
        const document = { uri: 'file:live-literals', get version() { return version; }, getText: () => text,
            positionAt: character => ({ line: 0, character }) };
        const vscode = { l10n: { t: value => value },
            Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
            WorkspaceEdit: class { changes = []; replace(uri, range, text) { this.changes.push({ uri, range, text }); } },
            workspace: { applyEdit: async edit => {
                assert.equal(edit.changes.length, 1);
                const change = edit.changes[0];
                text = text.slice(0, change.range.start.character) + change.text + text.slice(change.range.end.character);
                version++; return true;
            } } };
        const entry = path.resolve(__dirname, '../src/graphStatementEditor.ts'), mod = new (require('node:module'))(entry);
        mod.require = name => name === 'vscode' ? vscode : require(name);
        mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text, entry);
        const publish = async () => {
            await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(fixture(text))},uri:'file:///svg-example.lh',version:${version}},'*')`);
            await until(`document.querySelector('#app')?.dataset.graphVersion==='${version}' && document.querySelector('.literal-input') && !document.querySelector('.svg-export>button').disabled`);
        };
        await publish();
        for (const [index, value] of ['1234567890123456789', '日本語 "quoted"'].entries()) {
            if (index) { text = 'let^ value = "old"'; version++; await publish(); }
            const before = fixture(text);
            await evaluate(`document.querySelector('.literal-input').focus();document.querySelector('.literal-input').select()`);
            await call('Input.insertText', { text: value });
            await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await until(`window.edits.length===${index + 1}`);
            const message = await evaluate(`window.edits[${index}]`);
            assert.equal(message.type, 'editLiteral'); assert.equal(message.value, value);
            await assert.rejects(mod.exports.editStatementFromGraph(document, before, { ...message, version: version - 1 }, undefined, () => true));
            await mod.exports.editStatementFromGraph(document, before, message, undefined, () => true);
            assert.notEqual(text, before.source);
            await evaluate(`window.postMessage({type:'statementResult',id:${JSON.stringify(message.id)}},'*')`);
            await publish();
            assert.equal(await evaluate(`document.querySelector('.literal-input').value`), value);
        }
        await evaluate(`document.querySelector('.literal-input').focus();document.querySelector('.literal-input').select()`);
        await call('Input.insertText', { text: 'cancel me' });
        await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        assert.equal(await evaluate(`window.edits.length`), 2);
        assert.equal(await evaluate(`document.querySelector('.literal-input').value`), '日本語 "quoted"');
        assert.deepEqual(errors, []);
    });
});


test('expression menu changes a value reference and wraps it in a call without renaming declarations', { timeout: 60000 }, async () => {
    const fixture = value => {
        const source = `let^ value = ${value}`;
        const n = (kind, start, end, fields) => ({ kind, start, end, line: 1, column: start + 1, fields });
        const expression = value === '(fn)(nil^)' ? n('call', 13, source.length, {
            target: n('ident', 14, 16), argument: [n('hat-ident', 18, 22)] })
            : n(value === '0' ? 'int' : 'ident', 13, source.length);
        return { source, root: n('block', 0, source.length, { items: [n('define', 0, source.length, {
            targets: [n('ident', 5, 10)], values: [expression] })] }) };
    };
    let tree = fixture('0');
    const entry = path.resolve(__dirname, '../src/graphExpressions.ts'), mod = new (require('node:module'))(entry);
    mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
    await browser({ ...routes, '/': { type: 'text/html', body: html(tree) } }, async ({ evaluate, until, call, errors }) => {
        const ready = `document.querySelector('.expression-edit') && !document.querySelector('.svg-export>button').disabled`;
        await until(ready);
        for (const [index, query, expected] of [[0, 'fn', 'fn'], [1, 'Call this value', '(fn)(nil^)']]) {
            await evaluate(`document.querySelector('.expression-edit').click()`);
            await until(`document.querySelector('.statement-menu input')`);
            await call('Input.insertText', { text: query });
            await until(`document.querySelector('.statement-menu [role=option]')`);
            await evaluate(`document.querySelector('.statement-menu [role=option]').click()`);
            await until(`window.edits.length===${index + 1}`);
            const message = await evaluate(`window.edits[${index}]`);
            assert.equal(message.type, 'replaceExpression');
            const edit = mod.exports.replaceExpression(tree, message.site, message.template);
            const source = tree.source.slice(0, edit.start) + edit.text + tree.source.slice(edit.end);
            assert.equal(source, `let^ value = ${expected}`);
            tree = fixture(expected);
            await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(tree)},uri:'file:///svg-example.lh',version:${index + 2}},'*')`);
            await until(`document.querySelector('#app')?.dataset.graphVersion==='${index + 2}' && ${ready}`);
        }
        assert.equal(await evaluate(`document.querySelector('.expression-edit[data-expression-start="5"][data-expression-end="10"]')`), null);
        assert.deepEqual(errors, []);
    });
});


test('delete control removes a statement and the graph redraws as an empty editable document', { timeout: 60000 }, async () => {
    const source = 'let^ value = 1';
    const n = (kind, start, end, fields) => ({ kind, start, end, line: 1, column: start + 1, fields });
    const tree = { source, root: n('block', 0, source.length, { items: [n('define', 0, source.length, {
        targets: [n('ident', 5, 10)], values: [n('int', 13, 14)] })] }) };
    const entry = path.resolve(__dirname, '../src/graphStatementEditor.ts'), mod = new (require('node:module'))(entry);
    let text = source;
    const document = { uri: 'file:delete', version: 1, getText: () => text, positionAt: character => ({ line: 0, character }) };
    const vscode = { l10n: { t: value => value },
        Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
        WorkspaceEdit: class { changes = []; replace(uri, range, text) { this.changes.push({ uri, range, text }); } },
        workspace: { applyEdit: async edit => {
            assert.equal(edit.changes.length, 1);
            const change = edit.changes[0];
            text = text.slice(0, change.range.start.character) + change.text + text.slice(change.range.end.character);
            return true;
        } } };
    mod.require = name => name === 'vscode' ? vscode : require(name);
    mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text, entry);
    await browser({ ...routes, '/': { type: 'text/html', body: html(tree, false) } }, async ({ evaluate, until, errors }) => {
        await until(`document.querySelector('.element-delete') && !document.querySelector('.svg-export>button').disabled`);
        assert.equal(await evaluate(`document.querySelector('.element-delete[data-delete-start="13"][data-delete-end="14"]')`), null, 'a scalar value does not delete its enclosing statement');
        await evaluate(`document.querySelector('.element-delete').click()`);
        await until(`window.edits.length===1`);
        const message = await evaluate(`window.edits[0]`);
        assert.equal(message.type, 'deleteElement'); assert.equal(message.site.category, 'statement');
        await mod.exports.editStatementFromGraph(document, tree, message, undefined, () => true);
        assert.equal(text, '');
        await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify({ source: '', root: n('block', 0, 0, { items: [] }) })},uri:'file:///svg-example.lh',version:2},'*')`);
        await until(`document.querySelector('#app')?.dataset.graphVersion==='2' && !document.querySelector('.element-delete') && document.querySelector('.append-statement')`);
        await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(tree)},uri:'file:///svg-example.lh',version:3},'*')`);
        await until(`document.querySelector('#app')?.dataset.graphVersion==='3' && document.querySelector('.element-delete')`);
        assert.deepEqual(errors, []);
    });
});


test('conditional branches preserve their bodies when promoted removed and rebuilt through live controls', { timeout: 120000 }, async () => {
    const { graphHost, graphUi, normalizedAst, load } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('if^true^{print(17) el^false^:print(19) el^:print(23)}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/':{type:'text/html',body:html(host.tree,false)} }, async client => {
            const ui = await graphUi(host, client), conditional = () => host.tree.root.fields.items[0];
            const branch = index => conditional().fields.items[index];
            const literal = (node, value) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, value);
            const call = async (index, value) => {
                await ui.add('call', branch(index).fields.body);
                const argument = () => branch(index).fields.body.fields.items[0].fields.value.fields.argument[0];
                await ui.expression(argument(), 'number'); await literal(argument(), value);
            };
            await ui.add('if'); await graphToolbar(client, 'Unfold All'); await call(0, '17');
            await ui.structure(conditional(), 'branch'); await call(1, '19');
            await ui.structure(conditional(), 'else'); await call(2, '23');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.expression(branch(1).fields.condition, 'number'); await ui.expression(branch(1).fields.condition, 'compare');
            await graphToolbar(client, 'Unfold All'); await ui.operator(branch(1).fields.condition, '<');
            await literal(branch(1).fields.condition.fields.left, '29'); await literal(branch(1).fields.condition.fields.right, '31');
            await ui.structure(conditional(), 'remove-branch:0');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('if^(29<31){print(19) el^:print(23)}')), host.tree.source);
            await ui.remove(branch(1)); await ui.structure(conditional(), 'remove-branch:0');
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            await ui.add('let');
            const value = () => conditional().fields.values[0], alternative = index => value().fields.items[index];
            await ui.expression(value(), 'conditional'); await graphToolbar(client, 'Unfold All');
            await literal(alternative(0).fields.body, '17'); await literal(alternative(1).fields.body, '19');
            await ui.structure(value(), 'branch'); await literal(alternative(1).fields.body, '23');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('let^value=(if^true^:17 el^false^:23 el^:19;)')), host.tree.source);
            assert(!load('graphStructure.ts').structureTemplates(host.tree, value()).some(c => c.id === 'remove-branch:2'));
            await ui.remove(alternative(1)); await ui.structure(value(), 'remove-branch:0');
            assert.equal(value().kind, 'int'); assert.equal(host.tree.source.slice(value().start,value().end), '19');
            await ui.expression(value(), 'conditional'); await ui.remove(conditional());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0); assert.deepEqual(client.errors, []);
        });
    });
});

test('conditional and pattern frames retain predicates alternatives and values across semantic views', { timeout: 120000 }, async () => {
    const source = 'let^flow=p^{if^ready(17){left(19) el^other(23):middle(29) el^:right(31)} for^subject(37){when^41,43:hit(47) other^:miss(53)}} let^values={choice=(if^test(59):61 el^:67;),match=(for^subject(71):when^73:79 other^:83;)}';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), [flow, values] = tree.root.fields.items.map(n => n.fields.values[0]);
        const flat = n => [n,...Object.values(n.fields ?? {}).flat().flatMap(flat)];
        assert(!flat(tree.root).some(n => n.kind === 'error'), source);
        await browser({ ...routes, '/':{type:'text/html',body:html(tree,false)} }, async client => {
            const numbers = ['17','19','23','29','31','37','41','43','47','53','59','61','67','71','73','79','83'];
            const check = async (visible, absent = []) => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const number of visible) assert.equal(texts.filter(t => t === number).length, 1, number + ': ' + text);
                for (const number of absent) assert(!texts.includes(number), number + ': ' + text);
                return text;
            };
            for (const state of ['normal','folded']) {
                if (state === 'folded') await graphToolbar(client, 'Fold All');
                const text = (await svgTexts(client)).join(''); assert(text.includes('flow')); assert(text.includes('values'));
            }
            await graphToolbar(client, 'Unfold All');
            const expanded = await check(numbers);
            for (const role of ['Conditional Branch','Conditional Selection','Pattern Matching Branch','Pattern Matching Selection']) assert(expanded.includes(ja[role]), role + ': ' + expanded);
            for (const name of ['ready','left','other','middle','right','subject','hit','miss','test','choice','match']) assert(expanded.includes(name), name + ': ' + expanded);
            await saveSemanticSvg(client, 'conditional-pattern-frames');
            await graphToolbar(client, 'Fold All'); await drillGraphNode(client, flow); await graphToolbar(client, 'Unfold All');
            await check(numbers.slice(0,10), numbers.slice(10));
            await graphToolbar(client, 'Fold All'); await drillGraphNode(client, flow.fields.body.fields.items[0]); await graphToolbar(client, 'Unfold All');
            await check(numbers.slice(0,5), numbers.slice(5));
            await client.evaluate(`document.querySelector('#trail button').click()`); await client.until(graphReady); await graphToolbar(client, 'Fold All');
            await drillGraphNode(client, values); await graphToolbar(client, 'Unfold All'); await check(numbers.slice(10),numbers.slice(0,10));
            await graphToolbar(client, 'Fold All'); await drillGraphNode(client, values.fields.items[1].fields.value); await graphToolbar(client, 'Unfold All');
            const pattern = await check(numbers.slice(13),numbers.slice(0,13)); assert(pattern.includes(ja['Pattern Matching Selection']), pattern);
            assert.equal(await client.evaluate('window.edits.length'), 0); assert.deepEqual(client.errors, []);
        });
    });
});

test('branch menu updates a real parsed document and displays new branch conditions', { timeout: 60000 }, async () => {
    const { withLhatServer } = require('./lhat-server.cjs');
    await withLhatServer(async parse => {
        let tree = await parse('if^true^ { print(1) }');
        const entry = path.resolve(__dirname, '../src/graphStructure.ts'), mod = new (require('node:module'))(entry);
        mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree) } }, async ({ evaluate, until, errors }) => {
            const ready = `document.querySelector('.structure-edit') && !document.querySelector('.svg-export>button').disabled`;
            await until(ready);
            for (const [index, action, count] of [[0, 'branch', 2], [1, 'else', 3], [2, 'remove-branch:1', 2]]) {
                await evaluate(`document.querySelector('.structure-edit').click()`);
                await until(`document.querySelector('.statement-menu [role=option]')`);
                const choice = mod.exports.structureTemplates(tree, mod.exports.structureSites(tree)[0]).findIndex(c => c.id === action);
                assert(choice >= 0);
                await evaluate(`document.querySelector('.statement-menu [data-template-index="${choice}"]').click()`);
                await until(`window.edits.length===${index + 1}`);
                const message = await evaluate(`window.edits[${index}]`);
                assert.equal(message.type, 'editStructure');
                const change = mod.exports.editStructure(tree, message.site, message.action);
                tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
                assert.equal(tree.root.fields.items[0].fields.items.length, count);
                await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(tree)},uri:'file:///svg-example.lh',version:${index + 2}},'*')`);
                await until(`document.querySelector('#app')?.dataset.graphVersion==='${index + 2}' && ${ready}`);
                assert.equal(await evaluate(`document.querySelectorAll('.condition-node').length`), tree.root.fields.items[0].fields.items.filter(branch => branch.fields?.condition).length);
            }
            assert.deepEqual(errors, []);
        });
    });
});


test('loop structure menu switches modes and preserves the real parsed body', { timeout: 60000 }, async () => {
    const { withLhatServer } = require('./lhat-server.cjs');
    await withLhatServer(async parse => {
        const body = '{ print(1) }';
        let tree = await parse('repeat^3 ' + body);
        const entry = path.resolve(__dirname, '../src/graphStructure.ts'), mod = new (require('node:module'))(entry);
        mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree) } }, async ({ evaluate, until, errors }) => {
            const ready = `document.querySelector('.structure-edit') && !document.querySelector('.svg-export>button').disabled`;
            await until(ready);
            for (const [index, action] of ['mode:while', 'mode:until', 'mode:range'].entries()) {
                await evaluate(`document.querySelector('.structure-edit').click()`);
                await until(`document.querySelector('.statement-menu [role=option]')`);
                const choice = mod.exports.structureTemplates(tree, mod.exports.structureSites(tree)[0]).findIndex(c => c.id === action);
                await evaluate(`document.querySelector('.statement-menu [data-template-index="${choice}"]').click()`);
                await until(`window.edits.length===${index + 1}`);
                const message = await evaluate(`window.edits[${index}]`);
                assert.equal(message.type, 'editStructure'); assert.equal(message.action, action);
                const change = mod.exports.editStructure(tree, message.site, message.action);
                tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
                const loop = tree.root.fields.items[0];
                assert.equal(tree.source.slice(loop.fields.body.start, loop.fields.body.end), body);
                await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(tree)},uri:'file:///svg-example.lh',version:${index + 2}},'*')`);
                await until(`document.querySelector('#app')?.dataset.graphVersion==='${index + 2}' && ${ready}`);
            }
            assert.equal(tree.root.fields.items[0].kind, 'for');
            assert.deepEqual(errors, []);
        });
    });
});


test('empty document UI creates new statement families with real server ASTs', { timeout: 60000 }, async () => {
    const { withLhatServer } = require('./lhat-server.cjs');
    await withLhatServer(async parse => {
        const empty = await parse('');
        const entry = path.resolve(__dirname, '../src/graphStatements.ts'), mod = new (require('node:module'))(entry);
        mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
        await browser({ ...routes, '/': { type: 'text/html', body: html(empty) } }, async ({ evaluate, until, errors }) => {
            let version = 1;
            const choices = mod.exports.statementTemplates(empty, mod.exports.statementInsertions(empty)[0]);
            for (const [index, id] of ['call', 'assign', 'with', 'handled', 'type', 'tableDefinition', 'enumeration', 'error', 'module', 'import', 'require'].entries()) {
                await until(`document.querySelector('.append-statement') && !document.querySelector('.svg-export>button').disabled`);
                await evaluate(`document.querySelector('.append-statement').click()`);
                await until(`document.querySelector('.statement-menu [role=option]')`);
                const choice = choices.findIndex(c => c.id === id);
                assert(choice >= 0, id);
                await evaluate(`document.querySelector('.statement-menu [data-template-index="${choice}"]').click()`);
                await until(`window.edits.length===${index + 1}`);
                const message = await evaluate(`window.edits[${index}]`);
                assert.equal(message.type, 'insertStatement'); assert.equal(message.template, id);
                const change = mod.exports.insertStatementEdit(empty, message.site, message.template);
                const tree = await parse(change.text);
                assert.equal(tree.root.fields.items.length, 1, id);
                await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(tree)},uri:'file:///svg-example.lh',version:${++version}},'*')`);
                await until(`document.querySelector('#app')?.dataset.graphVersion==='${version}' && !document.querySelector('.svg-export>button').disabled`);
                await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(empty)},uri:'file:///svg-example.lh',version:${++version}},'*')`);
                await until(`document.querySelector('#app')?.dataset.graphVersion==='${version}' && document.querySelector('.append-statement') && !document.querySelector('.svg-export>button').disabled`);
            }
            assert.deepEqual(errors, []);
        });
    });
});


test('comment buttons and translated custom context menus add and remove comments through live source edits', { timeout: 60000 }, async () => {
    const { withLhatServer } = require('./lhat-server.cjs');
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'module^demo\nlet^Player=def^{self^{\n\t@export speed=400,\n\tother=2}}');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const { evaluate, until, errors } = client;
            const ui = await graphUi(host, client);
            await graphToolbar(client, 'Unfold All');
            const speed = () => host.tree.source.indexOf('speed');
            const node = () => `.box[data-source-start="${speed()}"]:not(.annotation-box)`;
            const clickAndApply = async selector => {
                await until(`document.querySelector(${JSON.stringify(selector)}) && ${graphReady}`);
                const point = await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}),r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);
                assert(point.hit, `Comment control must remain clickable: ${selector}`);
                await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
                await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
                await ui.accept();
            };
            await clickAndApply(`.react-flow__node:has(>${node()}) > .add-comment`);
            assert(host.tree.source.includes('\t# comment\n\t@export speed=400'));
            await ui.input('.comment-box:not(.annotation-box) textarea', 'first line\nsecond line');
            await clickAndApply('.comment-delete');
            assert(!host.tree.source.includes('#'));
            assert(host.tree.source.includes('@export speed=400'));
            const menu = async selector => {
                const prevented = await evaluate(`(()=>{const e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:150});document.querySelector(${JSON.stringify(selector)}).dispatchEvent(e);return e.defaultPrevented})()`);
                assert(prevented);
                await until('document.querySelector(".statement-menu [role=option]")');
                assert.equal(await evaluate('document.querySelector(".statement-menu .type-menu-header span").textContent'), 'ノードの操作');
                const labels = await evaluate('[...document.querySelectorAll(".statement-menu [role=option]")].map(e=>e.textContent)');
                assert(!labels.some(label => /Cut|Copy|Paste/.test(label)));
                return labels;
            };
            const labels = await menu(node());
            assert(labels.includes('コメントを追加'));
            await evaluate('[...document.querySelectorAll(".statement-menu [role=option]")].find(e=>e.textContent==="コメントを追加").click()');
            await ui.accept();
            assert(host.tree.source.includes('# comment'));
            await menu('.comment-box:not(.annotation-box)');
            await evaluate('[...document.querySelectorAll(".statement-menu [role=option]")].find(e=>e.textContent==="コメントを削除").click()');
            await ui.accept();
            assert(!host.tree.source.includes('#'));
            assert.equal(await evaluate('document.querySelectorAll(".comment-box:not(.annotation-box)").length'), 0);
            assert.deepEqual(errors, []);
        });
    });
});

test('consecutive comment blocks attach to annotated fields and edit together through the live source', { timeout: 60000 }, async () => {
    const { withLhatServer } = require('./lhat-server.cjs');
    const { load } = require('./graph-browser-host.cjs');
    await withLhatServer(async (parse, server) => {
        let tree = await parse('let^ Player = def^{ self^{\n\t# older block\n\t# older continuation\n\n\t# How fast the player will move (pixels/sec).\n\t# Main description\n\t@export speed = 400, # inline note\n\t# Size of the game window.\n\t# table, so what a field holds is the box\n\t# the type -- get() reads it back out.\n\tabstract^screenSize : i32^,\n}}');
        const speed = () => tree.source.indexOf('speed');
        const hover = await server.request('textDocument/hover', { textDocument: { uri: server.uri }, position: { line: 6, character: 10 } });
        assert.equal(hover.contents.kind, 'markdown');
        assert(hover.contents.value.endsWith('How fast the player will move (pixels/sec).\nMain description'));
        assert(!hover.contents.value.includes('older block'));
        assert(!hover.contents.value.includes('inline note'));
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree) } }, async ({ evaluate, until, call, errors }) => {
            await graphToolbar({ evaluate, until }, 'Unfold All');
            const selector = `.comment-box[data-source-start="${tree.source.indexOf('# Size')}"] textarea`;
            await until(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('.svg-export>button').disabled`);
            assert.equal(await evaluate(`document.querySelectorAll('.comment-box:not(.annotation-box)').length`), 4);
            assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), 'Size of the game window.\ntable, so what a field holds is the box\nthe type -- get() reads it back out.');
            const geometry = await evaluate(`(()=>{const annotation=document.querySelector('.annotation-box'),a=annotation.getBoundingClientRect(),d=document.querySelector('.box[data-source-start="${speed()}"]:not(.annotation-box)').getBoundingClientRect(),p=annotation.querySelector('.annotation-link path'),end=p.getPointAtLength(p.getTotalLength()),point=new DOMPoint(end.x,end.y).matrixTransform(p.getScreenCTM());return {annotationTop:a.top,declarationTop:d.top,linkEnd:point.x,declarationLeft:d.left,gap:d.left-a.right}})()`);
            assert(Math.abs(geometry.annotationTop - geometry.declarationTop) < 1, JSON.stringify(geometry));
            assert(Math.abs(geometry.linkEnd - geometry.declarationLeft) <= 1, JSON.stringify(geometry));
            assert(geometry.gap < 60, 'long comments must not centre the declaration far from its annotation');
            const definition = await evaluate(`(()=>{const d=document.querySelector('.box[data-source-start="${speed()}"]:not(.annotation-box)').parentElement.querySelector('[data-handleid="definition-in"]').getBoundingClientRect(),v=document.querySelector('.box[data-source-start="${tree.source.indexOf('400')}"]').parentElement.querySelector('[data-handleid="definition-out"]').getBoundingClientRect();return {declarationY:d.top+d.height/2,valueY:v.top+v.height/2}})()`);
            assert(Math.abs(definition.declarationY - definition.valueY) <= 1, JSON.stringify(definition));
            const links = await evaluate(`(()=>{const d=document.querySelector('.box[data-source-start="${speed()}"]:not(.annotation-box)').getBoundingClientRect();return [...document.querySelectorAll('.comment-box:not(.annotation-box)')].filter(b=>b.querySelector('textarea')?.value.includes('How fast')).map(b=>{const p=b.querySelector('.comment-link path'),end=p.getPointAtLength(p.getTotalLength()),point=new DOMPoint(end.x,end.y).matrixTransform(p.getScreenCTM());return {x:point.x,y:point.y,left:d.left,right:d.right,top:d.top}})})()`);
            assert.equal(links.length, 1);
            assert(links[0].x >= links[0].left && links[0].x <= links[0].right && Math.abs(links[0].y - links[0].top) <= 1, JSON.stringify(links));
            await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`);
            await call('Input.insertText', { text: 'Changed size\nsecond line\nthird line' });
            await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await until('window.edits.length===1');
            const message = await evaluate('window.edits[0]');
            const edit = load('graphTextFields.ts').editTextField(tree, message.site, message.value);
            assert(edit);
            tree = await parse(tree.source.slice(0, edit.start) + edit.text + tree.source.slice(edit.end));
            assert(tree.source.includes('\t# Changed size\n\t# second line\n\t# third line\n\tabstract^screenSize'));
            await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(tree)},uri:'file:///svg-example.lh',version:2},'*')`);
            await until(`document.querySelector('#app')?.dataset.graphVersion==='2' && document.querySelector(${JSON.stringify(selector)})?.value==='Changed size\\nsecond line\\nthird line' && !document.querySelector('.svg-export>button').disabled`);
            assert.equal(await evaluate('document.querySelectorAll(".comment-box:not(.annotation-box)").length'), 4);
            assert.deepEqual(errors, []);
        });
    });
});

test('inline module and comment fields write source then survive real AST refresh', { timeout: 60000 }, async () => {
    const { withLhatServer } = require('./lhat-server.cjs');
    await withLhatServer(async parse => {
        let tree = await parse('# old\nmodule^example.old\nimport^std.io\nlet^m = require^"./old.lh"');
        const entry = path.resolve(__dirname, '../src/graphTextFields.ts'), mod = new (require('node:module'))(entry);
        mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree) } }, async ({ evaluate, until, call, errors }) => {
            for (const [index, [kind, value]] of [['module', 'example.changed'], ['import', 'std.thread'], ['require', './日本語.lh'], ['comment', 'changed comment']].entries()) {
                const selector = `.interpolation-field.${kind} textarea`;
                await until(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('.svg-export>button').disabled`);
                await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`);
                await call('Input.insertText', { text: value });
                await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
                await until(`window.edits.length===${index + 1}`);
                const message = await evaluate(`window.edits[${index}]`);
                assert.equal(message.type, 'editTextField'); assert.equal(message.value, value);
                const change = mod.exports.editTextField(tree, message.site, message.value);
                tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
                await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(tree)},uri:'file:///svg-example.lh',version:${index + 2}},'*')`);
                await until(`document.querySelector('#app')?.dataset.graphVersion==='${index + 2}' && document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('.svg-export>button').disabled`);
                assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), value);
            }
            assert.deepEqual(errors, []);
        });
    });
});


test('unary operator context menu replaces the prefix and redraws the real AST', { timeout: 60000 }, async () => {
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        let tree = await parse('let^value = !true^');
        const entry = path.resolve(__dirname, '../src/graphLists.ts'), mod = new (require('node:module'))(entry);
        mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree) } }, async ({ evaluate, until, errors }) => {
            await until(`document.querySelector('.operator-box') && !document.querySelector('.svg-export>button').disabled`);
            await evaluate(`document.querySelector('.operator-box').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
            await until(`document.querySelector('.statement-menu [role=option]')`);
            await evaluate(`[...document.querySelectorAll('.statement-menu [role=option]')].find(e=>e.textContent.trim()==='bitnot^').click()`);
            await until(`window.edits.length===1`);
            const message = await evaluate(`window.edits[0]`);
            assert.equal(message.type, 'replaceOperator');
            const change = mod.exports.replaceOperatorEdit(tree, message, message.operator);
            tree = await parse(tree.source.slice(0, change.start)+change.text+tree.source.slice(change.end));
            assert.equal(tree.source, 'let^value = bitnot^true^');
            await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(tree)},uri:'file:///svg-example.lh',version:2},'*')`);
            await until(`document.querySelector('#app')?.dataset.graphVersion==='2' && document.querySelector('.operator-box') && !document.querySelector('.svg-export>button').disabled`);
            assert.deepEqual(errors, []);
        });
    });
});


test('pattern structure menu changes a pattern and adds a branch using real ASTs', { timeout: 60000 }, async () => {
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        let tree = await parse('for^1 { when^0: print(1) other^: print(2) }');
        const entry = path.resolve(__dirname, '../src/graphStructure.ts'), mod = new (require('node:module'))(entry);
        mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree) } }, async ({ evaluate, until, errors }) => {
            const ready = `document.querySelector('.structure-edit') && !document.querySelector('.svg-export>button').disabled`;
            await until(ready);
            for (const [index, action] of ['pattern:0:range', 'match-branch', 'remove-match:0'].entries()) {
                await evaluate(`document.querySelector('.structure-edit').click()`);
                await until(`document.querySelector('.statement-menu [role=option]')`);
                const site = mod.exports.structureSites(tree).find(s => s.kind === 'for');
                const choice = mod.exports.structureTemplates(tree, site).findIndex(c => c.id === action);
                await evaluate(`document.querySelector('.statement-menu [data-template-index="${choice}"]').click()`);
                await until(`window.edits.length===${index + 1}`);
                const message = await evaluate(`window.edits[${index}]`);
                assert.equal(message.type, 'editStructure'); assert.equal(message.action, action);
                const change = mod.exports.editStructure(tree, message.site, message.action);
                tree = await parse(tree.source.slice(0, change.start)+change.text+tree.source.slice(change.end));
                await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(tree)},uri:'file:///svg-example.lh',version:${index + 2}},'*')`);
                await until(`document.querySelector('#app')?.dataset.graphVersion==='${index + 2}' && ${ready}`);
            }
            assert.equal(tree.root.fields.items[0].fields.body.fields.items.length, 2);
            assert.deepEqual(errors, []);
        });
    });
});


test('expression picker builds qualified member references through the UI', { timeout: 60000 }, async () => {
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        let tree = await parse('let^value = 0');
        const entry = path.resolve(__dirname, '../src/graphExpressions.ts'), mod = new (require('node:module'))(entry);
        mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree) } }, async ({ evaluate, until, call, errors }) => {
            for (const [index, name] of ['self^.count', 'Item.new', 'items.length^', 'values.0'].entries()) {
                const value = tree.root.fields.items[0].fields.values[0];
                const selector = `.expression-edit[data-expression-start="${value.start}"][data-expression-end="${value.end}"]`;
                await until(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('.svg-export>button').disabled`);
                await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
                await until(`document.querySelector('.statement-menu input')`);
                await call('Input.insertText', { text: name });
                await until(`document.querySelector('.statement-menu [role=option]')`);
                await evaluate(`document.querySelector('.statement-menu [role=option]').click()`);
                await until(`window.edits.length===${index + 1}`);
                const message = await evaluate(`window.edits[${index}]`);
                assert.equal(message.type, 'replaceExpression'); assert.equal(message.template, `reference:${name}`);
                const change = mod.exports.replaceExpression(tree, message.site, message.template);
                tree = await parse(tree.source.slice(0, change.start)+change.text+tree.source.slice(change.end));
                assert.equal(tree.source, `let^value = ${name}`);
                await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(tree)},uri:'file:///svg-example.lh',version:${index + 2}},'*')`);
                await until(`document.querySelector('#app')?.dataset.graphVersion==='${index + 2}' && !document.querySelector('.svg-export>button').disabled`);
            }
            assert.deepEqual(errors, []);
        });
    });
});

test('packed and propagated values retain tuple editors through wrapping, unwrapping and deletion', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^value=try^(pack^((29,31)))'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), declaration = () => host.tree.root.fields.items[0], value = () => declaration().fields.values[0];
            await ui.add('let'); await ui.expression(value(), 'tuple');
            await ui.expression(value(), 'pack'); await ui.expression(value(), 'try');
            await graphToolbar(client, 'Unfold All');
            const tuple = () => value().fields.value.fields.value;
            for (const [index, text] of ['29','31'].entries())
                await ui.input(`.box[data-source-start="${tuple().fields.items[index].start}"] .literal-input`, text);
            assert.deepEqual(normalizedAst(host.tree), expected);
            await ui.expression(value(), 'unwrap'); assert.equal(value().kind, 'pack');
            await ui.expression(value(), 'unwrap'); assert.equal(value().kind, 'tuple');
            await ui.remove(value().fields.items[1]); assert.equal(value().kind, 'int');
            assert.equal(host.tree.source.slice(value().start,value().end), '29');
            await ui.remove(declaration());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('error payloads, error kinds and enumeration members clear and readd through live controls', { timeout: 120000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('public^errordef^Issue{Denied{code:number^},Empty} public^enum^Mode{Automatic,Seven=7} let^problem=error^Issue.Denied{code=17}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), items = () => host.tree.root.fields.items;
            const errors = () => items()[0], enumeration = () => items()[1], problem = () => items()[2].fields.values[0];
            const rename = (node, name) => ui.input(`.name-input[data-reference-start="${node.start}"]`, name);
            await ui.add('error'); await graphToolbar(client, 'Unfold All');
            await rename(errors().fields.name, 'Issue'); await rename(errors().fields.members[0].fields.name, 'Denied');
            await ui.structure(errors(), 'public');
            await ui.addElement('parameter', errors().fields.members[0], 'members');
            const parameter = () => errors().fields.members[0].fields.members[0];
            await rename(parameter().fields.name, 'code'); await ui.type(parameter().fields.name, 'number^');
            await ui.addElement('error', errors(), 'members'); await rename(errors().fields.members[1].fields.name, 'Empty');
            await ui.add('enumeration'); await graphToolbar(client, 'Unfold All');
            await rename(enumeration().fields.name, 'Mode'); await rename(enumeration().fields.members[0].fields.name, 'Automatic');
            await ui.structure(enumeration(), 'public');
            await ui.addElement('enum', enumeration(), 'members');
            await rename(enumeration().fields.members[1].fields.name, 'Seven');
            await ui.structure(enumeration().fields.members[1], 'enum:explicit');
            const number = () => enumeration().fields.members[1].fields.members[0];
            await ui.input(`.box[data-source-start="${number().start}"] .literal-input`, '7');
            await ui.add('let'); await rename(items()[2].fields.targets[0], 'problem');
            await ui.expression(problem(), 'error'); await graphToolbar(client, 'Unfold All');
            await ui.expression(problem().fields.name, 'reference:Issue.Denied');
            await ui.addElement('member', problem(), 'members');
            await rename(problem().fields.members[0].fields.key, 'code');
            await ui.input(`.box[data-source-start="${problem().fields.members[0].fields.value.start}"] .literal-input`, '17');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.expression(problem(), 'try');
            await ui.expression(problem().fields.value.fields.name, 'reference:Issue.Empty');
            await ui.remove(problem().fields.value.fields.members[0]);
            await ui.expression(problem(), 'unwrap');
            assert.equal(problem().kind, 'error-new'); assert.equal(problem().fields?.members?.length ?? 0, 0);
            await ui.addElement('member', problem(), 'members'); await ui.remove(problem().fields.members[0]);
            await ui.remove(items()[2]);
            await ui.remove(parameter());
            assert.equal(errors().fields.members[0].fields?.members?.length ?? 0, 0);
            await ui.addElement('parameter', errors().fields.members[0], 'members');
            for (let index = 1; index >= 0; index--) await ui.remove(errors().fields.members[index]);
            assert.equal(errors().fields?.members?.length ?? 0, 0);
            await ui.addElement('error', errors(), 'members'); assert.equal(errors().fields.members.length, 1);
            for (let index = 1; index >= 0; index--) await ui.remove(enumeration().fields.members[index]);
            assert.equal(enumeration().fields?.members?.length ?? 0, 0);
            await ui.addElement('enum', enumeration(), 'members'); assert.equal(enumeration().fields.members.length, 1);
            await ui.remove(enumeration()); await ui.remove(errors());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('wrapper roles and inner values survive folding and owner drilling without duplicate content', { timeout: 90000 }, async () => {
    const source = 'errordef^Issue{Empty} let^values={mutable=box^(17),sealed=constbox^("locked"),kind=typeof^({key=23}),descriptor=number^,collected=pack^((29,31)),expanded=f^{print((37,41)...)},propagated=try^(error^Issue.Empty{})}';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), table = tree.root.fields.items[1].fields.values[0];
        const flat = n => [n, ...Object.values(n.fields ?? {}).flat().flatMap(flat)];
        assert(!flat(tree.root).some(n => n.kind === 'error'), source);
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree, false) } }, async client => {
            const normal = await svgTexts(client); assert(normal.includes('values')); assert(normal.includes(ja.Table));
            const check = async () => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const number of ['17','23','29','31','37','41']) assert.equal(texts.filter(t => t === number).length, 1, JSON.stringify(texts));
                for (const value of ['mutable','sealed','kind','descriptor','collected','expanded','propagated','locked','Issue.Empty'])
                    assert(text.includes(value), value + ': ' + text);
                for (const role of ['Mutable box','Constant box','Type of','Pack as table','Propagate error'])
                    assert(texts.includes(ja[role]), role + ': ' + JSON.stringify(texts));
                assert(texts.some(t => t.includes('...')), JSON.stringify(texts));
                const descriptor = table.fields.items[3].fields.value;
                assert(await client.evaluate(`!!document.querySelector('.box[data-source-start="${descriptor.start}"][data-source-end="${descriptor.end}"] .semantic-label[title="number^"]')`));
            };
            await graphToolbar(client, 'Unfold All'); await check();
            await saveSemanticSvg(client, 'wrapped-values');
            await graphToolbar(client, 'Fold All');
            const folded = await svgTexts(client); assert(folded.includes('values')); assert(folded.includes(ja.Table));
            await drillGraphNode(client, table); await graphToolbar(client, 'Unfold All'); await check();
            assert.equal(await client.evaluate('window.edits.length'), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('enumerations, error kinds and constructed payloads preserve their contents across semantic views', { timeout: 90000 }, async () => {
    const source = 'public^enum^Mode{Automatic,Seven=7,Label="labelled"} public^errordef^Issue{Denied{code:number^=13},Empty} let^payload=error^Issue.Denied{code=17}';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), [enumeration, errors, declaration] = tree.root.fields.items;
        const flat = n => [n, ...Object.values(n.fields ?? {}).flat().flatMap(flat)];
        assert(!flat(tree.root).some(n => n.kind === 'error'), source);
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree, false) } }, async client => {
            const check = async (values, words, absent = []) => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const value of values) assert.equal(texts.filter(t => t === value).length, 1, JSON.stringify(texts));
                for (const word of words) assert(text.includes(word), word + ': ' + text);
                for (const word of absent) assert(!texts.includes(word), word + ': ' + text);
            };
            await check([], ['Mode','Issue','payload',ja.Enumeration,ja['Error definitions']]);
            assert.equal((await svgTexts(client)).filter(t => t === ja.Public).length, 2);
            await graphToolbar(client, 'Unfold All');
            await check(['7','13','17'], ['Automatic','Seven','Label','labelled','Denied','Empty','code','Issue.Denied']);
            await saveSemanticSvg(client, 'error-enum-values');
            await graphToolbar(client, 'Fold All');
            await check([], ['Mode','Issue','payload',ja.Enumeration,ja['Error definitions']]);
            for (const [node, values, words, absent] of [
                [enumeration, ['7'], ['Automatic','Seven','Label','labelled'], ['Denied','13','17']],
                [errors, ['13'], ['Denied','Empty','code'], ['Automatic','7','17']],
                [declaration.fields.values[0], ['17'], ['code'], ['Automatic','7','13']],
            ]) {
                await drillGraphNode(client, node); await graphToolbar(client, 'Unfold All');
                await check(values, words, absent);
                await client.evaluate(`document.querySelector('#trail button').click()`);
                await client.until(`!document.querySelector('#trail') && ${graphReady}`);
                await graphToolbar(client, 'Fold All');
            }
            assert.equal(await client.evaluate('window.edits.length'), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('expression constructors and error kind references remain editable through the UI', { timeout: 60000 }, async () => {
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        let tree = await parse('let^value = 0');
        const entry = path.resolve(__dirname, '../src/graphExpressions.ts'), mod = new (require('node:module'))(entry);
        mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree) } }, async ({ evaluate, until, call, errors }) => {
            const steps = [['true', 'hat-ident'], ['false', 'hat-ident'], ['nil', 'hat-ident'], ['number', 'int'], ['definition', 'def'], ['selfTable', 'self-table'], ['conditional', 'if-expr'], ['interpolation', 'interp'], ['try', 'try'], ['pack', 'pack'], ['error', 'error-new'], ['reference:Example.Failure', 'error-new']];
            for (const [index, [id, kind]] of steps.entries()) {
                const value = tree.root.fields.items[0].fields.values[0];
                const site = id.startsWith('reference:') ? mod.exports.expressionSites(tree).find(s => s.errorName) : value;
                const selector = `.expression-edit[data-expression-start="${site.start}"][data-expression-end="${site.end}"]`;
                await until(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('.svg-export>button').disabled`);
                await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
                await until(`document.querySelector('.statement-menu input')`);
                let choice;
                if (id.startsWith('reference:')) {
                    await call('Input.insertText', { text: id.slice(10) });
                    await until(`document.querySelector('.statement-menu [role=option]')`);
                    choice = 0;
                } else {
                    const offered = mod.exports.expressionTemplates(tree, site);
                    choice = offered.findIndex(c => c.id === id);
                    assert(choice >= 0, id);
                }
                await evaluate(`document.querySelector('.statement-menu [data-template-index="${choice}"]').click()`);
                await until(`window.edits.length===${index + 1}`);
                const message = await evaluate(`window.edits[${index}]`);
                assert.equal(message.template, id);
                const edit = mod.exports.replaceExpression(tree, message.site, message.template);
                tree = await parse(tree.source.slice(0, edit.start) + edit.text + tree.source.slice(edit.end));
                assert.equal(tree.root.fields.items[0].fields.values[0].kind, kind);
                if (['true', 'false', 'nil'].includes(id)) assert.equal(tree.source.trim(), 'let^value = ' + id + '^');
                await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(tree)},uri:'file:///svg-example.lh',version:${index + 2}},'*')`);
                await until(`document.querySelector('#app')?.dataset.graphVersion==='${index + 2}' && !document.querySelector('.svg-export>button').disabled`);
            }
            assert(tree.source.includes('error^Example.Failure{}'));
            assert.deepEqual(errors, []);
        });
    });
});

test('debug-fault sample is reconstructed from an empty document using only graph UI edits', { timeout: 60000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expectedSource = fs.readFileSync(path.join(__dirname, '../testing/debug-fault.lh'), 'utf8').replace(/\r\n/g, '\n');
        const expected = normalizedAst(await parse(expectedSource));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async ({ evaluate, until, call, errors }) => {
            const { add, input } = await graphUi(host, { evaluate, until, call });
            await add('comment');
            await input('.interpolation-field.comment textarea', expectedSource.split('\n')[0].slice(2));
            await add('var');
            await input('.name-input', 'kept');
            await input('.literal-input', '42');
            await add('panic');
            const panic = Object.values(host.tree.root.fields.items.at(-1).fields).flat().find(n => n.kind === 'string');
            await input(`.box[data-source-start="${panic.start}"] .literal-input`, 'debug fault');
            assert.deepEqual(normalizedAst(host.tree), expected);
            assert.deepEqual(errors, []);
        });
    });
});

test('debug-breakpoints sample is reconstructed through graph UI controls', { timeout: 60000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expectedSource = fs.readFileSync(path.join(__dirname, '../testing/debug-breakpoints.lh'), 'utf8').replace(/\r\n/g, '\n');
        const expected = normalizedAst(await parse(expectedSource));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client);
            await ui.add('comment');
            await ui.input('.interpolation-field.comment textarea', expectedSource.split('\n')[0].slice(2));
            await ui.add('var');
            await ui.input('.name-input', 'counter');
            await ui.add('repeat');
            const loop = () => host.tree.root.fields.items.find(n => n.kind === 'repeat');
            await ui.input('.box[data-source-start="' + loop().fields.bound.start + '"] .literal-input', '5');
            await ui.add('assign', loop().fields.body);
            const assignment = () => loop().fields.body.fields.items[0];
            await ui.expression(assignment().fields.targets[0], 'reference:counter');
            await ui.expression(assignment().fields.values[0], 'reference:counter');
            await ui.expression(assignment().fields.values[0], 'add');
            await ui.input('.box[data-source-start="' + assignment().fields.values[0].fields.right.start + '"] .literal-input', '1');
            await ui.add('return');
            await ui.expression(host.tree.root.fields.items.at(-1).fields.value[0], 'reference:counter');
            assert.deepEqual(normalizedAst(host.tree), expected);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('module declarations and both loading forms create, edit and delete through live controls', { timeout: 120000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = 'module^audit.描画 import^std.math require^"./読み込み.lh" let^modules={byName=import^std.thread,byFile=require^"./名前\\"付き.lh"}';
        const expected = normalizedAst(await parse(source)), host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), items = () => host.tree.root.fields.items;
            const table = () => items()[3].fields.values[0], entry = index => table().fields.items[index];
            const rename = (node, text) => ui.input(`.name-input[data-reference-start="${node.start}"]`, text);
            const path = (node, text) => ui.input(`.box[data-source-start="${node.start}"] .interpolation-input`, text);
            await ui.add('module'); await ui.input('.interpolation-field.module textarea', 'audit.描画');
            await ui.add('import'); await ui.input('.interpolation-field.import textarea', 'std.math');
            await ui.add('require'); await ui.input('.interpolation-field.require textarea', './読み込み.lh');
            await ui.add('let'); await rename(items()[3].fields.targets[0], 'modules');
            await ui.expression(table(), 'table'); await graphToolbar(client, 'Unfold All');
            for (const [index, key, kind, text] of [[0,'byName','import','std.thread'],[1,'byFile','require','./名前"付き.lh']]) {
                await ui.addElement('member', table()); await rename(entry(index).fields.key, key);
                await ui.expression(entry(index).fields.value, kind); await path(entry(index).fields.value, text);
            }
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.deepEqual(items().slice(0, 3).map(n => n.kind), ['module','import-stmt','require-stmt']);
            assert.deepEqual(table().fields.items.map(n => n.fields.value.kind), ['import','require']);
            await ui.expression(entry(0).fields.value, 'require'); await path(entry(0).fields.value, './別の場所.lh');
            await ui.expression(entry(0).fields.value, 'import'); await path(entry(0).fields.value, 'std.thread');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.remove(entry(0)); await ui.remove(entry(0));
            assert.equal(table().fields?.items?.length ?? 0, 0);
            await ui.addElement('member', table()); await ui.expression(entry(0).fields.value, 'require');
            await path(entry(0).fields.value, './再追加.lh');
            await ui.remove(items()[3]); await ui.remove(items()[2]); await ui.remove(items()[1]); await ui.remove(items()[0]);
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            await ui.add('module'); await ui.add('import'); await ui.add('require');
            assert.deepEqual(items().map(n => n.kind), ['module','import-stmt','require-stmt']);
            await ui.remove(items()[2]); await ui.remove(items()[1]); await ui.remove(items()[0]);
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('module names and loading paths remain distinct in normal folded and owner views', { timeout: 90000 }, async () => {
    const source = 'module^audit.描画 import^std.math require^"./読み込み.lh" let^modules={byName=import^std.thread,byFile=require^"./名前\\"付き.lh"}';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), table = tree.root.fields.items[3].fields.values[0];
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree, false) } }, async client => {
            const header = async () => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const value of ['audit.描画','std.math','./読み込み.lh','modules']) assert.equal(text.split(value).length, 2, text);
                for (const role of ['Module declaration','Import','Require']) assert(text.includes(ja[role]), role + ': ' + text);
            };
            await header(); await graphToolbar(client, 'Unfold All'); await header();
            const contents = async () => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const value of ['byName','byFile','std.thread','./名前"付き.lh']) assert.equal(text.split(value).length, 2, text);
                for (const role of ['Import','Require']) assert(text.includes(ja[role]), role + ': ' + text);
            };
            await contents(); await saveSemanticSvg(client, 'module-values');
            await graphToolbar(client, 'Fold All'); await header();
            const folded = (await svgTexts(client)).join('');
            assert(!folded.includes('byName')); assert(!folded.includes('byFile'));
            await drillGraphNode(client, table); await graphToolbar(client, 'Unfold All'); await contents();
            const drilled = (await svgTexts(client)).join('');
            for (const value of ['audit.描画','std.math','./読み込み.lh']) assert(!drilled.includes(value), drilled);
            assert.equal(await client.evaluate('window.edits.length'), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('reference-library sample is reconstructed with module and public declaration controls', { timeout: 60000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expectedSource = fs.readFileSync(path.join(__dirname, '../testing/reference-library.lh'), 'utf8').replace(/\r\n/g, '\n');
        const expected = normalizedAst(await parse(expectedSource));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client);
            await ui.add('module');
            await ui.input('.interpolation-field.module textarea', 'examples.referenceLibrary');
            await ui.add('let');
            await ui.input('.name-input', 'code');
            const declaration = () => host.tree.root.fields.items.find(n => n.kind === 'define');
            await ui.expression(declaration().fields.values[0], 'string');
            await ui.input('.literal-input', 'SKU');
            await ui.structure(declaration(), 'public');
            assert.deepEqual(normalizedAst(host.tree), expected);
            await ui.structure(declaration(), 'mutability');
            assert(host.tree.source.includes('public^ var^'));
            await ui.structure(declaration(), 'mutability');
            await ui.structure(declaration(), 'public');
            assert(!host.tree.source.includes('public^'));
            await ui.structure(declaration(), 'public');
            assert.deepEqual(normalizedAst(host.tree), expected);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('definition and self fields retain editors after clearing constructors, templates and all members', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^Counter=def^{self^{count:number^=11},version=13,override^new=f^{return^self^{count=17}},read=f^self^{return^self^.count}}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), declaration = () => host.tree.root.fields.items[0];
            const def = () => declaration().fields.values[0], template = () => def().fields.items[0].fields.value;
            const constructor = () => def().fields.items[2].fields.value, instance = () => constructor().fields.body.fields.items[0].fields.value[0];
            const unfold = async () => {
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await client.until(`!document.querySelector('.svg-export>button').disabled`);
            };
            const rename = (node, name) => ui.input(`.name-input[data-reference-start="${node.start}"]`, name);
            const literal = (node, value) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, value);
            await ui.add('tableDefinition'); await rename(declaration().fields.targets[0], 'Counter'); await unfold();
            await ui.addElement('self', def()); await unfold();
            await ui.addElement('member', template());
            await rename(template().fields.items[0].fields.key, 'count');
            await literal(template().fields.items[0].fields.value, '11');
            await ui.type(template().fields.items[0].fields.key, 'number^');
            await ui.addElement('member', def()); await rename(def().fields.items[1].fields.key, 'version');
            await literal(def().fields.items[1].fields.value, '13');
            await ui.addElement('constructor', def()); await unfold();
            await ui.add('return', constructor().fields.body);
            await ui.expression(instance(), 'selfTable'); await unfold();
            await ui.addElement('member', instance());
            await rename(instance().fields.items[0].fields.key, 'count');
            await literal(instance().fields.items[0].fields.value, '17');
            await ui.addElement('member', def()); await rename(def().fields.items[3].fields.key, 'read');
            await ui.expression(def().fields.items[3].fields.value, 'function'); await unfold();
            const method = () => def().fields.items[3].fields.value;
            await ui.addElement('receiver', method(), 'params');
            await ui.expression(method().fields.body.fields.items[0].fields.value[0], 'reference:self^.count');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.remove(instance().fields.items[0]);
            assert.equal(instance().fields?.items?.length ?? 0, 0);
            await ui.addElement('member', instance());
            assert.equal(instance().fields.items.length, 1);
            for (let index = 3; index >= 0; index--) await ui.remove(def().fields.items[index]);
            assert.equal(def().fields?.items?.length ?? 0, 0);
            await ui.addElement('self', def()); await unfold();
            assert.equal(template().fields?.items?.length ?? 0, 0);
            await ui.addElement('member', template());
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('let^Counter=def^{self^{value=0}}')));
            await ui.remove(declaration());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('definition and self contents preserve member identities and modifiers across semantic views', { timeout: 90000 }, async () => {
    const source = 'let^Counter=def^{self^{count:number^=11},version=13,abstract^limit:number^,override^new=f^{self^{count=17}},read=f^self^{self^.count},overload^read=f^self^,rhs:number^{rhs},op^+ =f^self^,rhs:Self^{return^self^},base={},delegate^base}';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), def = tree.root.fields.items[0].fields.values[0];
        const flat = node => [node, ...Object.values(node.fields ?? {}).flat().flatMap(flat)];
        assert(!flat(tree.root).some(node => node.kind === 'error'), source);
        const instance = def.fields.items[3].fields.value.fields.body.fields.items[0].fields.value[0];
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree, false) } }, async client => {
            const { evaluate, until, call } = client, ready = `!document.querySelector('.svg-export>button').disabled`;
            const normal = await svgTexts(client);
            assert(normal.includes('Counter')); assert(normal.includes(ja['Table type definition']), JSON.stringify(normal));
            const unfold = async () => {
                await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await until(ready);
            };
            const checkDefinition = async () => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const value of ['11','13','17']) assert.equal(texts.filter(t => t === value).length, 1, JSON.stringify(texts));
                for (const name of ['count','version','limit','new','read','rhs','base',ja.Abstract,ja.Override,ja.Overload,ja.Delegate,ja['Operator definition'],'+'])
                    assert(text.includes(name), name + ': ' + text);
                const spacing = await evaluate(`(()=>{const keyword=document.querySelector('.semantic-label[title="op^"]'),symbol=[...keyword.parentElement.querySelectorAll('.typed-name>span')].find(e=>e.textContent.trim()==='+');return symbol ? symbol.getBoundingClientRect().left-keyword.getBoundingClientRect().right : null})()`);
                assert(spacing !== null && spacing >= 3, 'operator symbol gap: ' + spacing);
                assert(texts.filter(t => t.includes(ja.Self)).length >= 2, JSON.stringify(texts));
            };
            const drill = async node => {
                const selector = `.box.folded[data-source-start="${node.start}"][data-source-end="${node.end}"]`;
                await until(`document.querySelector(${JSON.stringify(selector)}) && ${ready}`);
                let point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+8,y:r.top+8}})()`);
                if (point.y < 80 || point.y > 600 || point.x < 0 || point.x > 950) {
                    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 350, deltaY: point.y-180, deltaX: point.x < 0 || point.x > 950 ? point.x-200 : 0 });
                    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
                    point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+8,y:r.top+8}})()`);
                }
                assert(point.x > 0 && point.x < 1000 && point.y > 60 && point.y < 690, JSON.stringify(point));
                for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent', { type, ...point, button:'left', clickCount:1 });
                await until(`document.querySelector('#trail') && ${ready}`);
            };
            await unfold(); await checkDefinition();
            if (process.env.LHAT_TEST_DEFINITION_SVG) fs.writeFileSync(process.env.LHAT_TEST_DEFINITION_SVG,
                await evaluate('window.exports.at(-1).svg'));
            await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Fold All').click()`); await until(ready);
            const folded = await svgTexts(client); assert(folded.includes('Counter')); assert(folded.includes(ja['Table type definition']));
            await drill(def); await unfold(); await checkDefinition();
            const selfSelector = `.box[data-source-start="${instance.start}"][data-source-end="${instance.end}"] .foldbtn`;
            await evaluate(`document.querySelector(${JSON.stringify(selfSelector)}).click()`); await until(ready);
            await drill(instance); await unfold();
            const contents = await svgTexts(client);
            assert(contents.includes('17') && contents.includes('count'), JSON.stringify(contents));
            assert(!contents.includes('version') && !contents.includes('13'), JSON.stringify(contents));
            assert.equal(await evaluate('window.edits.length'), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('definition members expose modifier and operator controls after UI creation', { timeout: 60000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client);
            await ui.add('tableDefinition');
            const def = () => host.tree.root.fields.items[0].fields.values[0];
            const unfold = async () => {
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await client.until(`!document.querySelector('.svg-export>button').disabled`);
            };
            await unfold();
            await ui.addElement('operator', def());
            await unfold();
            await ui.structure(def().fields.items[0], 'operator:=');
            assert(host.tree.source.includes('op^='));
            await ui.structure(def().fields.items[0], 'modifier:override^');
            assert(host.tree.source.includes('override^'));
            await ui.structure(def().fields.items[0], 'modifier:overload^');
            assert(host.tree.source.includes('overload^') && !host.tree.source.includes('override^'));
            await ui.structure(def().fields.items[0], 'modifier:plain');
            await ui.addElement('abstract', def());
            await unfold();
            await ui.structure(def().fields.items[1], 'modifier:plain');
            assert(!host.tree.source.includes('abstract^'));
            await ui.structure(def().fields.items[1], 'modifier:abstract^');
            assert(host.tree.source.includes('abstract^'));
            await ui.addElement('self', def());
            await unfold();
            assert.equal(def().fields.items[2].fields.value.kind, 'self-table');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('enum sample is reconstructed with implicit and explicit member values through graph UI', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/enum.lh'), 'utf8').replace(/\r\n/g, '\n');
        const expected = normalizedAst(await parse(source));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client);
            const unfold = async () => {
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await client.until(`!document.querySelector('.svg-export>button').disabled`);
            };
            const enumeration = () => host.tree.root.fields.items.find(n => n.kind === 'enumdef');
            const member = index => enumeration().fields.members[index];
            const rename = async (node, name) => ui.input(`.name-input[data-reference-start="${node.start}"]`, name);
            const literal = async (node, value) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, value);
            await ui.add('module');
            await ui.input('.interpolation-field.module textarea', 'examples.enums');
            await ui.add('comment');
            await ui.input('.interpolation-field.comment textarea', source.split('\n')[2].slice(2));
            await ui.add('enumeration');
            await unfold();
            await rename(enumeration().fields.name, 'Mode');
            await ui.structure(enumeration(), 'public');
            await unfold();
            await rename(member(0).fields.name, 'Idle');
            for (const [index, name] of ['Walk', 'Dash', 'Label', 'Data'].entries()) {
                await ui.addElement('enum', enumeration(), 'members');
                await unfold();
                await rename(member(index + 1).fields.name, name);
                if (name === 'Walk') continue;
                await ui.structure(member(index + 1), 'enum:explicit');
                if (name === 'Dash') await literal(member(index + 1).fields.members[0], '10');
                if (name === 'Label') {
                    await ui.expression(member(index + 1).fields.members[0], 'string');
                    await literal(member(index + 1).fields.members[0], 'dash');
                }
                if (name === 'Data') {
                    await ui.expression(member(index + 1).fields.members[0], 'table');
                    const table = () => member(index + 1).fields.members[0];
                    for (let number = 1; number <= 3; number++) {
                        await ui.addElement('number', table());
                        await unfold();
                        const entry = table().fields.items[number - 1];
                        await literal(entry.fields?.value ?? entry, String(number));
                    }
                }
            }
            await ui.add('let');
            const declaration = () => host.tree.root.fields.items.find(n => n.kind === 'define');
            await rename(declaration().fields.targets[0], 'current');
            await ui.expression(declaration().fields.values[0], 'reference:Mode.Idle');
            assert.deepEqual(normalizedAst(host.tree), expected);
            await ui.structure(member(2), 'enum:implicit');
            assert(!member(2).fields.members);
            await ui.structure(member(2), 'enum:explicit');
            await literal(member(2).fields.members[0], '10');
            assert.deepEqual(normalizedAst(host.tree), expected);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('references sample is reconstructed with typed parameters, local names and require aliases', { timeout: 120000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/references.lh'), 'utf8').replace(/\r\n/g, '\n');
        const expected = normalizedAst(await parse(source));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client);
            const items = () => host.tree.root.fields.items;
            const fn = () => items().find(n => n.kind === 'define' && n.fields.values[0].kind === 'func').fields.values[0];
            const rename = (node, name) => ui.input(`.name-input[data-reference-start="${node.start}"]`, name);
            const unfold = async () => {
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await client.until(`!document.querySelector('.svg-export>button').disabled`);
            };
            await ui.add('comment');
            await ui.input('.interpolation-field.comment textarea', source.split('\n')[0].slice(2));
            await ui.add('require');
            await ui.input('.interpolation-field.require textarea', 'reference-library.lh');
            await ui.add('let');
            await rename(items().at(-1).fields.targets[0], 'library');
            await ui.expression(items().at(-1).fields.values[0], 'require');
            await ui.input(`.box[data-source-start="${items().at(-1).fields.values[0].start}"] .interpolation-field.require textarea`, 'reference-library.lh');
            await ui.add('function');
            await rename(items().at(-1).fields.targets[0], 'build');
            await unfold();
            for (const [index, name] of ['sku', 'name'].entries()) {
                await ui.addElement('parameter', fn(), 'params');
                await unfold();
                await rename(fn().fields.params[index].fields.name, name);
                await ui.type(fn().fields.params[index].fields.name, 'string^');
            }
            await ui.add('let', fn().fields.body, fn().fields.body.fields.items[0]);
            const copy = () => fn().fields.body.fields.items[0];
            await rename(copy().fields.targets[0], 'copy');
            await ui.expression(copy().fields.values[0], 'reference:sku');
            const returned = () => fn().fields.body.fields.items[1].fields.value[0];
            await ui.expression(returned(), 'table');
            for (const [index, [key, value]] of [['sku', 'copy'], ['name', 'name']].entries()) {
                await ui.addElement('member', returned());
                await unfold();
                await rename(returned().fields.items[index].fields.key, key);
                await ui.expression(returned().fields.items[index].fields.value, `reference:${value}`);
            }
            for (const [name, value] of [['fromModule', 'examples.referenceLibrary.code'], ['fromAlias', 'library.code']]) {
                await ui.add('let');
                await rename(items().at(-1).fields.targets[0], name);
                await ui.expression(items().at(-1).fields.values[0], `reference:${value}`);
            }
            assert.deepEqual(normalizedAst(host.tree), expected);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('localization sample is reconstructed with explicit types, Unicode names and exact literal text', { timeout: 120000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/localization.lh'), 'utf8').replace(/\r\n/g, '\n');
        const expected = normalizedAst(await parse(source));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client);
            const items = () => host.tree.root.fields.items;
            const nameOf = target => target.fields?.name ?? target;
            const rename = (node, name) => ui.input(`.name-input[data-reference-start="${node.start}"]`, name);
            const literal = (node, value) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, value);
            const unfold = async () => {
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await client.until(`!document.querySelector('.svg-export>button').disabled`);
            };
            await ui.add('module');
            await ui.input('.interpolation-field.module textarea', 'examples.localization');
            await ui.add('comment');
            await ui.input('.interpolation-field.comment textarea', source.split('\n')[2].slice(2));
            for (const [id, name, value, type] of [
                ['let', 'message', 'let^ string^ number^', 'string^'],
                ['var', '金額', '1234567890123456789', 'number^'],
                ['let', 'empty', '', undefined], ['let', 'lines', 'first\nsecond', undefined],
            ]) {
                await ui.add(id);
                await rename(nameOf(items().at(-1).fields.targets[0]), name);
                if (type !== 'number^') await ui.expression(items().at(-1).fields.values[0], 'string');
                if (value !== '') await literal(items().at(-1).fields.values[0], value);
                if (type) await ui.type(nameOf(items().at(-1).fields.targets[0]), type);
            }
            await ui.add('function');
            await rename(items().at(-1).fields.targets[0], 'convert');
            const fn = () => items().find(n => n.kind === 'define' && n.fields.values[0].kind === 'func').fields.values[0];
            await unfold();
            for (const [index, [name, type]] of [['text', 'string^'], ['count', 'number^']].entries()) {
                await ui.addElement('parameter', fn(), 'params'); await unfold();
                await rename(fn().fields.params[index].fields.name, name);
                await ui.type(fn().fields.params[index].fields.name, type);
            }
            await ui.add('var', fn().fields.body, fn().fields.body.fields.items[0]);
            const result = () => fn().fields.body.fields.items[0];
            await rename(nameOf(result().fields.targets[0]), 'result');
            await ui.expression(result().fields.values[0], 'reference:text');
            await ui.type(nameOf(result().fields.targets[0]), 'string^');
            await ui.expression(fn().fields.body.fields.items[1].fields.value[0], 'reference:result');
            await ui.type(fn(), 'string^');
            await ui.add('let');
            await rename(items().at(-1).fields.targets[0], 'table');
            await ui.expression(items().at(-1).fields.values[0], 'table');
            const table = () => items().at(-1).fields.values[0];
            for (const [index, [name, value]] of [['name', '日本語'], ['count', '42']].entries()) {
                await ui.addElement('member', table()); await unfold();
                await rename(table().fields.items[index].fields.key, name);
                if (name === 'name') await ui.expression(table().fields.items[index].fields.value, 'string');
                await literal(table().fields.items[index].fields.value, value);
            }
            assert.deepEqual(normalizedAst(host.tree), expected);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('returns sample is reconstructed with conditional, empty, implicit and multiple results', { timeout: 180000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/returns.lh'), 'utf8').replace(/\r\n/g, '\n');
        const expected = normalizedAst(await parse(source));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client);
            const items = () => host.tree.root.fields.items;
            const lastFunction = () => items().at(-1).fields.values[0];
            const rename = (node, name) => ui.input(`.name-input[data-reference-start="${node.start}"]`, name);
            const literal = (node, value) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, value);
            const unfold = async () => {
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await client.until(`!document.querySelector('.svg-export>button').disabled`);
            };
            await ui.add('module');
            await ui.input('.interpolation-field.module textarea', 'examples.returns');
            await ui.add('function'); await rename(items().at(-1).fields.targets[0], 'describe'); await unfold();
            await ui.addElement('parameter', lastFunction(), 'params'); await unfold();
            await rename(lastFunction().fields.params[0].fields.name, 'n');
            await ui.type(lastFunction().fields.params[0].fields.name, 'number^');
            const tail = () => lastFunction().fields.body.fields.items.at(-1);
            await ui.expression(tail().fields.value[0], 'string');
            await literal(tail().fields.value[0], 'other');
            await ui.add('if', lastFunction().fields.body, tail()); await unfold();
            const branch = () => lastFunction().fields.body.fields.items[0].fields.items[0];
            await ui.expression(branch().fields.condition, 'reference:n');
            await ui.expression(branch().fields.condition, 'compare');
            await ui.operator(branch().fields.condition, '>');
            await ui.add('return', branch().fields.body);
            const positive = () => branch().fields.body.fields.items[0].fields.value[0];
            await ui.expression(positive(), 'string'); await literal(positive(), 'positive');
            await ui.type(lastFunction(), 'string^');
            await ui.add('procedure'); await rename(items().at(-1).fields.targets[0], 'empty'); await unfold();
            await ui.add('return', lastFunction().fields.body);
            await ui.add('comment');
            await ui.input('.interpolation-field.comment textarea', source.split('\n').find(line=>line.startsWith('# An')).slice(2));
            await ui.add('function'); await rename(items().at(-1).fields.targets[0], 'implicit'); await unfold();
            await ui.addElement('parameter', lastFunction(), 'params'); await unfold();
            await rename(lastFunction().fields.params[0].fields.name, 'n');
            await ui.type(lastFunction().fields.params[0].fields.name, 'number^');
            const implicit = () => lastFunction().fields.body.fields.items[0];
            await ui.expression(implicit().fields.value[0], 'reference:n');
            await ui.expression(implicit().fields.value[0], 'add');
            await ui.operator(implicit().fields.value[0], '*');
            await literal(implicit().fields.value[0].fields.right, '2');
            await ui.structure(implicit(), 'return:implicit');
            await ui.add('comment');
            await ui.input(`.box[data-source-start="${host.tree.source.lastIndexOf('#')}"] .interpolation-field.comment textarea`, source.split('\n').find(line=>line.startsWith('# Drill')).slice(2));
            await ui.add('function'); await rename(items().at(-1).fields.targets[0], 'many'); await unfold();
            const many = () => lastFunction().fields.body.fields.items[0];
            await literal(many().fields.value[0], '100');
            for (let i = 101; i < 120; i++) {
                await ui.addElement('number', many(), 'value');
                await literal(many().fields.value.at(-1), String(i));
            }
            assert.deepEqual(normalizedAst(host.tree), expected);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('empty sample remains an editable graph with its first statement entry point', { timeout: 30000 }, async () => {
    const { graphHost, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/empty.lh'), 'utf8');
        const expected = normalizedAst(await parse(source));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            await client.until(`document.querySelector('.append-statement:not(:disabled)') && !document.querySelector('.svg-export>button').disabled`);
            assert.deepEqual(normalizedAst(host.tree), expected);
            assert.equal(await client.evaluate('window.edits.length'), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('literals sample is reconstructed with raw spelling, nested definitions, defaults and interpolation', { timeout: 180000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/literals.lh'), 'utf8').replace(/\r\n/g, '\n');
        const expected = normalizedAst(await parse(source));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client);
            const items = () => host.tree.root.fields.items;
            const value = () => items().at(-1).fields.values[0];
            const rename = (node, name) => ui.input(`.name-input[data-reference-start="${node.start}"]`, name);
            const literal = (node, text) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, text);
            const unfold = async () => {
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await client.until(`!document.querySelector('.svg-export>button').disabled`);
            };
            const binding = async (name, template) => {
                await ui.add('let'); await rename(items().at(-1).fields.targets[0], name);
                if (template) await ui.expression(value(), template);
            };
            const comment = async text => {
                await ui.add('comment');
                await ui.input(`.box[data-source-start="${host.tree.source.lastIndexOf('#')}"] .interpolation-field.comment textarea`, text);
            };
            await ui.add('module');
            await ui.input('.interpolation-field.module textarea', 'examples.literals');
            await comment(source.split('\n').find(line=>line.startsWith('# Literal')).slice(2));
            for (const [name, template, text] of [
                ['amount', undefined, '-3.5'], ['message', 'string', '  Hello, 世界  '],
                ['precise', undefined, '1234567890123456789'], ['hex', undefined, '0xFF'],
                ['empty', 'string', ''], ['multiline', 'string', 'first\nsecond'], ['raw', 'string', 'C:\\temp\\file.txt'],
            ]) {
                await binding(name, template);
                if (text !== '') await literal(value(), text);
                if (name === 'raw') {
                    await ui.structure(value(), 'string:raw');
                    await literal(value(), 'C:\\temp\\other.txt'); await literal(value(), text);
                    assert(host.tree.source.includes("'C:\\temp\\file.txt'"));
                }
            }
            await binding('values', 'table'); await unfold();
            for (const [index, text] of ['10', '15', '1_000', '2.5e-3', 'sample'].entries()) {
                await ui.addElement(index === 4 ? 'string' : 'number', value());
                const entry = value().fields.items[index]; await literal(entry.fields?.value ?? entry, text);
            }
            await binding('nested', 'definition'); await unfold();
            await ui.addElement('member', value());
            await rename(value().fields.items[0].fields.key, 'count'); await literal(value().fields.items[0].fields.value, '42');
            await ui.addElement('member', value());
            await rename(value().fields.items[1].fields.key, 'read');
            await ui.expression(value().fields.items[1].fields.value, 'function'); await unfold();
            const read = () => value().fields.items[1].fields.value.fields.body.fields.items[0];
            await ui.expression(read().fields.value[0], 'string'); await literal(read().fields.value[0], 'inside');
            await ui.structure(read(), 'return:implicit');
            await ui.add('enumeration'); await unfold();
            const enumeration = () => items().at(-1);
            await rename(enumeration().fields.name, 'Mode');
            await rename(enumeration().fields.members[0].fields.name, 'Idle');
            for (const [index, [name, text]] of [['Label', 'ready'], ['Code', '7']].entries()) {
                await ui.addElement('enum', enumeration(), 'members'); await unfold();
                await rename(enumeration().fields.members[index + 1].fields.name, name);
                await ui.structure(enumeration().fields.members[index + 1], 'enum:explicit');
                if (name === 'Label') await ui.expression(enumeration().fields.members[index + 1].fields.members[0], 'string');
                await literal(enumeration().fields.members[index + 1].fields.members[0], text);
            }
            await ui.add('error'); await unfold();
            const kind = () => items().at(-1).fields.members[0];
            await rename(kind().fields.name, 'Missing');
            for (const [index, [name, template, text]] of [['name', 'string', ''], ['code', 'number', '404']].entries()) {
                await ui.addElement('parameter', kind(), 'members');
                await rename(kind().fields.members[index].fields.name, name);
                await ui.structure(kind().fields.members[index], 'default:add');
                await ui.expression(kind().fields.members[index].fields.fallback, template);
                if (text !== '') await literal(kind().fields.members[index].fields.fallback, text);
                await ui.type(kind().fields.members[index].fields.name, undefined);
            }
            await ui.structure(kind().fields.members[1], 'default:remove');
            await ui.structure(kind().fields.members[1], 'default:add');
            await ui.expression(kind().fields.members[1].fields.fallback, 'number');
            await literal(kind().fields.members[1].fields.fallback, '404');
            await comment(source.split('\n').find(line=>line.startsWith('# Expressions')).slice(2));
            await binding('expression', 'add');
            await literal(value().fields.left, '1'); await literal(value().fields.right, '2');
            await binding('interpolation', 'interpolation');
            await ui.input('.interpolation-field.text textarea', 'amount: ');
            const hole = value().fields.items.find(n => n.kind === 'interp-hole');
            await ui.expression(hole.fields.value, 'reference:amount');
            assert.deepEqual(normalizedAst(host.tree), expected);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('function parameter defaults expose editable value nodes and retain removal controls', { timeout: 60000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client);
            await ui.add('function');
            const fn = () => host.tree.root.fields.items[0].fields.values[0];
            const unfold = async () => {
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await client.until(`!document.querySelector('.svg-export>button').disabled`);
            };
            await unfold(); await ui.addElement('parameter', fn(), 'params'); await unfold();
            const param = () => fn().fields.params[0];
            await ui.type(param().fields.name, 'string^');
            await ui.structure(param(), 'default:add');
            await ui.input(`.box[data-source-start="${param().fields.fallback.start}"] .literal-input`, 'hello, 世界');
            assert(host.tree.source.includes('"hello, 世界"'));
            await ui.structure(param(), 'default:remove');
            assert(!param().fields.fallback);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('callable parameters retain defaults and references after clearing and rebuilding the signature', { timeout: 120000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^function=f^amount:number^=17,...:string^{return^amount}'));
        const rebuilt = normalizedAst(await parse('let^function=f^count:number^=19,...:string^{return^count}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), fn = () => host.tree.root.fields.items[0].fields.values[0];
            const parameter = () => fn().fields.params[0], returned = () => fn().fields.body.fields.items[0].fields.value[0];
            const rename = text => ui.input(`.name-input[data-reference-start="${parameter().fields.name.start}"]`, text);
            const signature = async (name, value) => {
                await ui.addElement('parameter', fn(), 'params'); await rename(name);
                await ui.type(parameter().fields.name, 'number^'); await ui.structure(parameter(), 'default:add');
                await ui.input(`.box[data-source-start="${parameter().fields.fallback.start}"] .literal-input`, value);
                await ui.addElement('variadic', fn(), 'params');
                const variadic = fn().fields.params[1];
                await ui.typeStructure({ start: variadic.start, end: variadic.start + 3 }, 'type:name:string^');
            };
            await ui.add('function'); await graphToolbar(client, 'Unfold All'); await signature('amount', '17');
            await ui.expression(returned(), 'reference:amount');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await rename('count');
            assert.equal(host.tree.source.slice(returned().start, returned().end), 'count');
            await ui.structure(parameter(), 'default:remove'); assert(!parameter().fields.fallback);
            await ui.structure(parameter(), 'default:add');
            await ui.input(`.box[data-source-start="${parameter().fields.fallback.start}"] .literal-input`, '19');
            await ui.remove(fn().fields.params[1]); await ui.remove(parameter());
            assert.equal(fn().fields?.params?.length ?? 0, 0);
            await signature('count', '19');
            assert.deepEqual(normalizedAst(host.tree), rebuilt, host.tree.source);
            await ui.remove(host.tree.root.fields.items[0]);
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('variadic annotations omit and restore their editable type seat through live source changes', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst, load } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const bare = normalizedAst(await parse('let^function=f^...{return^0}'));
        const typed = normalizedAst(await parse('let^function=f^...:number^{return^(...[0])}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), fn = () => host.tree.root.fields.items[0].fields.values[0];
            const site = () => load('graphTypes.ts').typeSites(host.tree).find(s => s.name === '...');
            const result = () => fn().fields.body.fields.items[0].fields.value[0];
            await ui.add('function'); await graphToolbar(client, 'Unfold All'); await ui.addElement('variadic', fn(), 'params');
            await ui.type(site(), undefined);
            assert.deepEqual(normalizedAst(host.tree), bare, host.tree.source);
            assert.equal(site().typeText, 'any^'); assert(!site().required);
            await ui.type(site(), 'string^');
            await ui.typeStructure(site(), 'type:tuple');
            assert.equal(fn().fields.params[0].fields.type.kind, 'type-tuple');
            await ui.type(site(), undefined);
            assert.deepEqual(normalizedAst(host.tree), bare, host.tree.source);
            await ui.type(site(), 'number^');
            await ui.expression(result(), 'reference:...'); await ui.expression(result(), 'index');
            assert.deepEqual(normalizedAst(host.tree), typed, host.tree.source);
            await ui.expression(result(), 'number'); await ui.remove(fn().fields.params[0]);
            assert.equal(fn().fields?.params?.length ?? 0, 0);
            await ui.remove(host.tree.root.fields.items[0]);
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('callable signatures keep defaults result slots and modifiers through semantic views', { timeout: 90000 }, async () => {
    const source = 'let^read=template^f^first:number^=17,second:string^="default",...:bool^ ->(number^,string^){return^first,second} let^make=f^seed:number^=19 -> fresh^t^{value:number^}{return^{value=seed}} let^run=p^message:string^="ready"{print(message)}';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), functions = tree.root.fields.items.map(n => n.fields.values[0]);
        const flat = n => [n,...Object.values(n.fields ?? {}).flat().flatMap(flat)];
        assert(!flat(tree.root).some(n => n.kind === 'error'), source);
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree, false) } }, async client => {
            const check = async () => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const number of ['17','19']) assert.equal(texts.filter(t => t === number).length, 1, text);
                for (const value of ['first','second','seed','message','default','ready','...']) assert(text.includes(value), value + ': ' + text);
                for (const role of ['Function','Procedure','Input','Output','Fresh','Callable template']) assert(text.includes(ja[role]), role + ': ' + text);
                assert.equal(text.split(ja.Boolean).length, 2, 'The variadic type is shown once: ' + text);
                const variadic = functions[0].fields.params[2];
                assert.equal(await client.evaluate(`document.querySelector('.box[data-source-start="${variadic.start}"][data-source-end="${variadic.end}"] .typed-name>span')?.textContent`), '...');
                const returns = functions[0].fields.return_type.fields.items;
                for (const [index, result] of returns.entries()) assert(await client.evaluate(`!!document.querySelector('.type-label[data-type-start="${result.start}"][data-result-index="${index}"]')`));
            };
            await check(); await graphToolbar(client, 'Unfold All'); await check();
            await saveSemanticSvg(client, 'callable-signatures');
            await graphToolbar(client, 'Fold All'); await check();
            for (const [index, fn] of functions.entries()) {
                if (index) { await client.evaluate(`document.querySelector('#trail button').click()`); await client.until(graphReady); await graphToolbar(client, 'Fold All'); }
                await drillGraphNode(client, fn); await graphToolbar(client, 'Unfold All');
                const texts = await svgTexts(client), text = texts.join('');
                for (const value of index === 0 ? ['read','first','second','17','default','...'] : index === 1 ? ['make','seed','19','value'] : ['run','message','ready','print'])
                    assert(text.includes(value), value + ': ' + text);
                for (const other of functions.filter(n => n !== fn)) {
                    const first = other.fields.params[0].fields.fallback;
                    const value = source.slice(first.start, first.end).replaceAll('"', '');
                    assert(!texts.includes(value), text);
                }
            }
            assert.equal(await client.evaluate('window.edits.length'), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('computed literal keys retain input editors and their value type controls', { timeout: 60000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client);
            await ui.add('let');
            const table = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.expression(table(), 'table');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await client.until(`!document.querySelector('.svg-export>button').disabled`);
            await ui.addElement('member', table());
            const member = () => table().fields.items[0];
            await ui.structure(member(), 'key:string');
            const keyInput = () => `.box[data-source-start="${member().start}"] .literal-input`;
            await ui.input(keyInput(), 'request-method');
            await ui.expression(member().fields.value, 'string');
            await ui.input(`.box[data-source-start="${member().fields.value.start}"] .literal-input`, 'GET');
            await ui.type(member().fields.key, 'string^');
            assert.equal(member().fields.type.kind, 'type-name');
            await ui.type(member().fields.key, undefined);
            await ui.input(keyInput(), 'method');
            await ui.structure(member(), 'key:identifier');
            assert.equal(member().computed, false);
            await ui.structure(member(), 'key:number');
            await ui.input(keyInput(), '7');
            assert.equal(member().computed, true);
            assert.equal(member().fields.key.kind, 'int');
            assert(host.tree.source.includes('[7]'));
            assert(host.tree.source.includes('"GET"'));
            await ui.addElement('number', table());
            await ui.expression(table().fields.items[1].fields.value, 'compare');
            const comparison = () => table().fields.items[1].fields.value;
            await ui.input('.box[data-source-start="' + comparison().fields.left.start + '"] .literal-input', '1');
            await ui.remove(comparison());
            assert.equal(table().fields.items.length, 1);
            assert.equal(table().fields.items[0].computed, true);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('member-definitions sample is reconstructed with computed keys, receivers and typed payload defaults', { timeout: 180000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/member-definitions.lh'), 'utf8').replace(/\r\n/g, '\n');
        const expected = normalizedAst(await parse(source));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), items = () => host.tree.root.fields.items;
            const rename = (node, name) => ui.input(`.name-input[data-reference-start="${node.start}"]`, name);
            const literal = (node, text) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, text);
            const unfold = async () => {
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await client.until(`!document.querySelector('.svg-export>button').disabled`);
            };
            await ui.add('module'); await ui.input('.interpolation-field.module textarea', 'examples.memberDefinitions');
            await ui.add('var'); await rename(items().at(-1).fields.targets[0], 'count');
            await ui.add('let'); await rename(items().at(-1).fields.targets[0], 'settings');
            const settings = () => items()[2].fields.values[0];
            await ui.expression(settings(), 'table'); await unfold();
            await ui.addElement('member', settings());
            await rename(settings().fields.items[0].fields.key, 'enabled');
            await ui.expression(settings().fields.items[0].fields.value, 'true');
            await ui.addElement('member', settings());
            await ui.structure(settings().fields.items[1], 'key:string');
            await ui.input(`.box[data-source-start="${settings().fields.items[1].start}"] .literal-input`, 'request-method');
            await ui.expression(settings().fields.items[1].fields.value, 'string');
            await literal(settings().fields.items[1].fields.value, 'GET');
            await ui.addElement('member', settings());
            await rename(settings().fields.items[2].fields.key, 'nested');
            await ui.expression(settings().fields.items[2].fields.value, 'table');
            const nested = () => settings().fields.items[2].fields.value;
            for (const [index, [name, template, text]] of [['limit', 'number', '10'], ['name', 'string', 'sample']].entries()) {
                await ui.addElement('member', nested());
                await rename(nested().fields.items[index].fields.key, name);
                if (template === 'string') await ui.expression(nested().fields.items[index].fields.value, template);
                await literal(nested().fields.items[index].fields.value, text);
            }
            await ui.addElement('number', settings());
            const comparison = () => settings().fields.items[3].fields.value;
            await ui.expression(comparison(), 'compare');
            await literal(comparison().fields.left, '1'); await literal(comparison().fields.right, '1');
            await ui.addElement('number', settings()); await literal(settings().fields.items[4].fields.value, '42');
            await ui.add('enumeration'); await unfold();
            const enumeration = () => items()[3];
            await rename(enumeration().fields.name, 'Mode'); await rename(enumeration().fields.members[0].fields.name, 'Idle');
            for (const [index, [name, text]] of [['Walk', undefined], ['Dash', '10'], ['Label', 'dash']].entries()) {
                await ui.addElement('enum', enumeration(), 'members');
                await rename(enumeration().fields.members[index + 1].fields.name, name);
                if (text === undefined) continue;
                await ui.structure(enumeration().fields.members[index + 1], 'enum:explicit');
                if (name === 'Label') await ui.expression(enumeration().fields.members[index + 1].fields.members[0], 'string');
                await literal(enumeration().fields.members[index + 1].fields.members[0], text);
            }
            await ui.add('tableDefinition'); await rename(items().at(-1).fields.targets[0], 'Counter'); await unfold();
            const counter = () => items()[4].fields.values[0];
            await ui.addElement('self', counter());
            const self = () => counter().fields.items[0].fields.value;
            await ui.addElement('member', self()); await rename(self().fields.items[0].fields.key, 'count');
            await ui.type(self().fields.items[0].fields.key, 'number^');
            await ui.addElement('member', counter()); await rename(counter().fields.items[1].fields.key, 'version');
            await literal(counter().fields.items[1].fields.value, '1');
            await ui.addElement('abstract', counter()); await rename(counter().fields.items[2].fields.key, 'limit');
            await ui.addElement('constructor', counter()); await unfold();
            const constructor = () => counter().fields.items[3].fields.value;
            await ui.addElement('parameter', constructor(), 'params');
            await rename(constructor().fields.params[0].fields.name, 'count');
            await ui.type(constructor().fields.params[0].fields.name, 'number^');
            await ui.add('return', constructor().fields.body);
            const constructed = () => constructor().fields.body.fields.items[0];
            await ui.expression(constructed().fields.value[0], 'selfTable');
            await ui.addElement('member', constructed().fields.value[0]);
            await rename(constructed().fields.value[0].fields.items[0].fields.key, 'count');
            await ui.expression(constructed().fields.value[0].fields.items[0].fields.value, 'reference:count');
            await ui.structure(constructed(), 'return:implicit');
            await ui.addElement('member', counter()); await rename(counter().fields.items[4].fields.key, 'read');
            await ui.expression(counter().fields.items[4].fields.value, 'function'); await unfold();
            const read = () => counter().fields.items[4].fields.value;
            await ui.addElement('receiver', read(), 'params');
            await ui.expression(read().fields.body.fields.items[0].fields.value[0], 'reference:self^.count');
            await ui.structure(read().fields.body.fields.items[0], 'return:implicit');
            await ui.addElement('operator', counter()); await unfold();
            await ui.structure(counter().fields.items[5], 'operator:=');
            const equality = () => counter().fields.items[5].fields.value.fields.body.fields.items[0];
            await ui.expression(equality().fields.value[0], 'reference:self^.count');
            await ui.expression(equality().fields.value[0], 'compare');
            await ui.expression(equality().fields.value[0].fields.right, 'reference:rhs.count');
            await ui.structure(equality(), 'return:implicit');
            await ui.add('error'); await rename(items().at(-1).fields.name, 'StockError'); await unfold();
            const error = () => items()[5];
            await rename(error().fields.members[0].fields.name, 'OutOfStock');
            for (const [index, [name, type]] of [['sku', 'string^'], ['wanted', 'number^']].entries()) {
                const kind = () => error().fields.members[0];
                await ui.addElement('parameter', kind(), 'members');
                await rename(kind().fields.members[index].fields.name, name); await ui.type(kind().fields.members[index].fields.name, type);
                await ui.structure(kind().fields.members[index], 'default:add');
            }
            await ui.addElement('error', error(), 'members');
            await rename(error().fields.members[1].fields.name, 'UnknownSku');
            await ui.addElement('parameter', error().fields.members[1], 'members');
            await rename(error().fields.members[1].fields.members[0].fields.name, 'sku');
            await ui.type(error().fields.members[1].fields.members[0].fields.name, 'string^');
            assert.deepEqual(normalizedAst(host.tree), expected);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('parallel initializer controls create a three-output call without extra arguments', { timeout: 90000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client);
            const items = () => host.tree.root.fields.items;
            const fn = () => items()[0].fields.values[0];
            const returned = () => fn().fields.body.fields.items[0];
            await ui.add('function');
            await ui.input('.name-input', 'f');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await client.until(`!document.querySelector('.svg-export>button').disabled`);
            await ui.addElement('number', returned(), 'value');
            await ui.addElement('number', returned(), 'value');
            for (let i = 0; i < 3; i++) await ui.input(`.box[data-source-start="${returned().fields.value[i].start}"] .literal-input`, String(i + 1));
            await ui.structure(returned(), 'return:implicit');
            await ui.add('let'); await ui.input(`.name-input[data-reference-start="${items()[1].fields.targets[0].start}"]`, 'a');
            for (const name of ['b', 'c']) {
                await ui.addElement('binding', items()[1], 'targets');
                await ui.input(`.name-input[data-reference-start="${items()[1].fields.targets.at(-1).start}"]`, name);
            }
            await ui.initializers(items()[1], 'reference:f');
            await ui.expression(items()[1].fields.values[0], 'call');
            assert.equal(items()[1].fields.targets.length, 3);
            assert.equal(items()[1].fields.values.length, 1);
            assert.equal(items()[1].fields.values[0].fields.argument?.length ?? 0, 0);
            assert.equal(items()[1].fields.values[0].callable.outputs.length, 3);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('parallel bindings preserve pairs through modifiers edits deletion and reinsertion', { timeout: 120000 }, async () => {
    const { graphHost, graphUi, normalizedAst, load } = require('./graph-browser-host.cjs');
    const { assignmentValues } = load('graphAssignments.ts');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('public^var^alpha:number^,beta:string^=17,"second" alpha,beta:=23,"next" alpha?+=29'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type:'text/html', body:html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), items = () => host.tree.root.fields.items, declaration = () => items()[0];
            const target = index => declaration().fields.targets[index].fields?.name ?? declaration().fields.targets[index];
            const rename = (node, text) => ui.input(`.name-input[data-reference-start="${node.start}"]`, text);
            const literal = (node, text) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, text);
            await ui.add('var'); await rename(target(0), 'alpha');
            await literal(declaration().fields.values[0], '17'); await ui.type(target(0), 'number^');
            await ui.addElement('binding', declaration(), 'targets'); await rename(target(1), 'beta');
            await ui.expression(declaration().fields.values[1], 'string');
            await literal(declaration().fields.values[1], 'second'); await ui.type(target(1), 'string^');
            await ui.structure(declaration(), 'public');
            await ui.add('assign'); const paired = () => items()[1];
            await ui.expression(paired().fields.targets[0], 'reference:alpha'); await literal(assignmentValues(paired(), host.tree.source)[0], '23');
            await ui.addElement('binding', paired(), 'targets');
            await ui.expression(paired().fields.targets[1], 'reference:beta');
            await ui.expression(assignmentValues(paired(), host.tree.source)[1], 'string');
            await literal(assignmentValues(paired(), host.tree.source)[1], 'next');
            await ui.add('assign'); const compound = () => items()[2];
            await ui.expression(compound().fields.targets[0], 'reference:alpha');
            await literal(assignmentValues(compound(), host.tree.source)[0], '29');
            await ui.structure(compound(), 'assignment:+='); await ui.structure(compound(), 'assignment:nil-check');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            for (const id of ['assignment:*=','assignment:nil-check','assignment::=']) await ui.structure(compound(), id);
            const rhs = assignmentValues(compound(), host.tree.source)[0];
            assert.equal(host.tree.source.slice(rhs.start, rhs.end), '29');
            await ui.remove(assignmentValues(paired(), host.tree.source)[0]);
            assert.equal(paired().fields.targets.length, 1);
            assert.equal(host.tree.source.slice(paired().fields.targets[0].start, paired().fields.targets[0].end), 'beta');
            await ui.addElement('binding', paired(), 'targets'); await ui.expression(paired().fields.targets[1], 'reference:alpha');
            await ui.expression(assignmentValues(paired(), host.tree.source)[1], 'number');
            await literal(assignmentValues(paired(), host.tree.source)[1], '31');
            const changed = normalizedAst(await parse('public^var^alpha:number^,beta:string^=17,"second" beta,alpha:="next",31 alpha:=29'));
            assert.deepEqual(normalizedAst(host.tree), changed, host.tree.source);
            await ui.remove(paired().fields.targets[1]);
            assert.equal(paired().fields.targets.length, 1); assert.equal(assignmentValues(paired(), host.tree.source).length, 1);
            await ui.remove(compound()); await ui.remove(paired());
            await ui.type(target(0), undefined); await ui.structure(declaration(), 'mutability'); await ui.structure(declaration(), 'public');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('let^alpha,beta:string^=17,"second"')), host.tree.source);
            await ui.structure(declaration(), 'mutability'); await ui.remove(declaration());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            await ui.add('var'); await ui.add('assign'); await ui.remove(items()[1]); await ui.remove(declaration());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('declaration and reassignment captions keep each value and modifier in semantic views', { timeout: 90000 }, async () => {
    const source = 'public^var^alpha:number^,beta:string^=17,"second" let^run=p^{var^count,limit=19,23 count,limit:=29,31 count?+=37 limit*=41}';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), fn = tree.root.fields.items[1].fields.values[0];
        const flat = n => [n,...Object.values(n.fields ?? {}).flat().flatMap(flat)];
        assert(!flat(tree.root).some(n => n.kind === 'error'), source);
        await browser({ ...routes, '/': { type:'text/html', body:html(tree, false) } }, async client => {
            const outer = async () => {
                const text = (await svgTexts(client)).join('');
                for (const value of ['alpha','beta','17','second','run',ja.Public,ja['Mutable Variable Definition']]) assert(text.includes(value), value + ': ' + text);
            };
            const inner = async () => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const number of ['19','23','29','31','37','41']) assert.equal(texts.filter(t => t === number).length, 1, text);
                for (const name of ['count','limit']) assert.equal(texts.filter(t => t === name).length, 3, text);
                for (const label of [ja.Reassignment,ja['Multiplication Assignment'],ja['{0} (nil-checked)'].replace('{0}', ja['Addition Assignment'])]) assert(text.includes(label), label + ': ' + text);
            };
            await outer(); await graphToolbar(client, 'Unfold All'); await outer(); await inner(); await saveSemanticSvg(client, 'parallel-bindings');
            await graphToolbar(client, 'Fold All'); await outer();
            await drillGraphNode(client, fn); await graphToolbar(client, 'Unfold All'); await inner();
            const drilled = await svgTexts(client); assert(!drilled.includes('17')); assert(!drilled.join('').includes('second'));
            assert.equal(await client.evaluate('window.edits.length'), 0); assert.deepEqual(client.errors, []);
        });
    });
});

test('parallel reassignment adds its target and value in one edit', { timeout: 60000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'var^a2=0\nvar^a3=0\na2:=0');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), assignment = () => host.tree.root.fields.items[2];
            await ui.addElement('binding', assignment(), 'targets');
            assert.equal(host.version, 2);
            assert.equal(assignment().fields.values.length, 2);
            await ui.expression(assignment().fields.targets[1], 'reference:a3');
            await ui.expression(assignment().fields.values[1], 'number');
            assert.equal(assignment().fields.targets.length, 2);
            assert.equal(assignment().fields.values.length, 2);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('multiple-returns sample is reconstructed through calls, parallel bindings and error handling', { timeout: 240000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/multiple-returns.lh'), 'utf8').replace(/\r\n/g, '\n');
        const expected = normalizedAst(await parse(source));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), items = () => host.tree.root.fields.items;
            const rename = (node, text) => ui.input(`.name-input[data-reference-start="${node.start}"]`, text);
            const literal = (node, text) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, text);
            const unfold = async () => {
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await client.until(`!document.querySelector('.svg-export>button').disabled`);
            };
            const define = async (kind, name) => {
                await ui.add(kind); const index = items().length - 1;
                await rename(items()[index].fields.targets[0], name);
                return () => items()[index];
            };
            const fn = async (name, params = []) => {
                const declaration = await define('function', name); await unfold();
                const value = () => declaration().fields.values[0];
                for (const param of params) {
                    await ui.addElement('parameter', value(), 'params');
                    await rename(value().fields.params.at(-1).fields.name, param);
                    await ui.type(value().fields.params.at(-1).fields.name, undefined);
                }
                return value;
            };
            const returned = f => f().fields.body.fields.items[0];
            const call = async (value, name, args) => {
                await ui.expression(value(), `reference:${name}`);
                await ui.expression(value(), 'call');
                for (const [index, arg] of args.entries()) {
                    if (!value().fields.argument?.[index]) await ui.addElement('default', value(), 'argument');
                    const argument = () => value().fields.argument[index];
                    if (typeof arg === 'number') {
                        if (argument().kind !== 'int') await ui.expression(argument(), 'number');
                        if (host.tree.source.slice(argument().start, argument().end) !== String(arg)) await literal(argument(), String(arg));
                    } else await ui.expression(argument(), `reference:${arg}`);
                }
            };
            const print = async names => {
                await ui.add('call'); const index = items().length - 1, value = () => items()[index].fields.value;
                for (let i = 0; i < names.length; i++) {
                    if (i) await ui.addElement('default', value(), 'argument');
                    await ui.expression(value().fields.argument[i], `reference:${names[i]}`);
                }
                return value;
            };
            const bindCall = async (names, name, args) => {
                const binding = await define('let', names[0]);
                for (const next of names.slice(1)) {
                    await ui.addElement('binding', binding(), 'targets'); await rename(binding().fields.targets.at(-1), next);
                }
                await ui.initializers(binding(), `reference:${name}`);
                const value = () => binding().fields.values[0];
                await call(value, name, args);
            };
            const f = await fn('f');
            await ui.addElement('number', returned(f), 'value'); await ui.addElement('number', returned(f), 'value');
            for (let i = 0; i < 3; i++) await literal(returned(f).fields.value[i], String(i + 1));
            await ui.structure(returned(f), 'return:implicit');
            await bindCall(['a', 'b', 'c'], 'f', []); await print(['a', 'b', 'c']);
            const f3 = await fn('f3', ['x']);
            const f3result = () => returned(f3).fields.value[0];
            await ui.expression(f3result(), 'reference:x'); await ui.expression(f3result(), 'add');
            await ui.operator(f3result(), '*'); await literal(f3result().fields.right, '10');
            await ui.structure(returned(f3), 'return:implicit');
            const f2 = await fn('f2', ['x', 'y', 'z']);
            await ui.addElement('number', returned(f2), 'value'); await ui.addElement('number', returned(f2), 'value');
            const result = i => returned(f2).fields.value[i];
            await ui.expression(result(0), 'reference:x'); await ui.expression(result(0), 'add');
            await ui.operator(result(0), '*'); await literal(result(0).fields.right, '2');
            await ui.expression(result(0), 'add'); await literal(result(0).fields.right, '1');
            await call(() => result(1), 'f3', ['y']); await ui.expression(result(1), 'add'); await literal(result(1).fields.right, '2');
            await ui.expression(result(2), 'reference:z'); await ui.expression(result(2), 'add'); await literal(result(2).fields.right, '3');
            await ui.structure(returned(f2), 'return:implicit');
            await bindCall(['a1', 'b1', 'c1'], 'f2', [3, 4, 5]); await print(['a1', 'b1', 'c1']);
            await ui.add('error'); await rename(items().at(-1).fields.name, 'E'); await unfold();
            await rename(items().at(-1).fields.members[0].fields.name, 'Err1');
            const f4 = await fn('f4', ['x']);
            const conditional = () => returned(f4).fields.value[0];
            await ui.expression(conditional(), 'conditional');
            const branch = i => conditional().fields.items[i];
            await ui.expression(branch(0).fields.condition, 'reference:x'); await ui.expression(branch(0).fields.condition, 'compare');
            await ui.operator(branch(0).fields.condition, '>');
            await ui.expression(branch(0).fields.body, 'reference:x');
            await ui.expression(branch(1).fields.body, 'error'); await unfold();
            await ui.expression(branch(1).fields.body.fields.name, 'reference:E.Err1');
            await ui.structure(returned(f4), 'return:implicit');
            const a2 = await define('var', 'a2'), a2value = () => a2().fields.values[0];
            await call(a2value, 'f4', [10]); await ui.expression(a2value(), 'try'); await print(['a2']);
            const b2 = await define('var', 'b2'); await call(() => b2().fields.values[0], 'f4', [10]);
            const printB2 = await print(['b2']); await ui.expression(printB2().fields.argument[0], 'try');
            const a3 = await define('var', 'a3'), a3value = () => a3().fields.values[0];
            await call(a3value, 'f4', [10]); await ui.expression(a3value(), 'fallback');
            await ui.operator(a3value(), 'catch^'); await ui.expression(a3value().fields.right, 'number');
            const b3 = await define('let', 'b3'); await call(() => b3().fields.values[0], 'print', ['a3']);
            await ui.add('assign'); const assignment = () => items().at(-1);
            await ui.expression(assignment().fields.targets[0], 'reference:a2');
            await ui.addElement('binding', assignment(), 'targets');
            await ui.expression(assignment().fields.targets[1], 'reference:a3'); await ui.expression(assignment().fields.values[1], 'number');
            await ui.add('call'); const final = () => items().at(-1).fields.value.fields.argument[0];
            await ui.expression(final(), 'function'); await unfold();
            await literal(final().fields.body.fields.items[0].fields.value[0], '100');
            await ui.structure(final().fields.body.fields.items[0], 'return:implicit'); await ui.expression(final(), 'call');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('deleting a parallel value removes its binding and keeps the remaining graph editable', { timeout: 60000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'let^a,b,c=(1,(2),3)');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), binding = () => host.tree.root.fields.items[0];
            const values = () => binding().fields.values[0].fields.items;
            await ui.remove(values()[1]);
            assert.equal(host.version, 2);
            assert.equal(binding().fields.targets.length, 2);
            assert.deepEqual(values().map(n => host.tree.source.slice(n.start, n.end)), ['1', '3']);
            await ui.addElement('binding', binding(), 'targets');
            assert.equal(binding().fields.targets.length, 3);
            assert.equal(values().length, 3);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('standalone call menus preserve statement shape through handlers and keep target and argument editors', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst, load } = require('./graph-browser-host.cjs');
    const expressions = load('graphExpressions.ts');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), value = () => host.tree.root.fields.items[0].fields.value;
            await ui.add('call');
            await ui.expression(value().fields.target, 'reference:work');
            await ui.expression(value(), 'try');
            await ui.expression(value(), 'fallback');
            const call = () => value().fields.left.fields.value;
            const site = expressions.expressionSites(host.tree).find(s => s.kind === 'call' && s.start === call().start);
            assert(site.statementExpression);
            await client.evaluate(`document.querySelector('.expression-edit[data-expression-start="${call().start}"][data-expression-end="${call().end}"]').click()`);
            await client.until(`document.querySelector('.statement-menu [role=option]')`);
            assert(!await client.evaluate(`[...document.querySelectorAll('.statement-menu [role=option]')].some(e=>e.textContent.includes('数値')||e.textContent.includes('Number'))`));
            await client.call('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
            await ui.expression(call().fields.args?.[0] ?? call().fields.argument[0], 'number');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('(try^(work(0)))??nil^')), host.tree.source);
            assert.equal(host.tree.root.fields.items[0].kind, 'call-stmt');
            assert.equal(value().kind, 'binary');
            assert(!JSON.stringify(host.tree.root).includes('"kind":"error"'), host.tree.source);
            assert.equal(await client.evaluate(`document.querySelectorAll('.element-delete[data-delete-start="0"][data-delete-end="${host.tree.root.fields.items[0].end}"]').length`), 1);
            await ui.remove(host.tree.root.fields.items[0]);
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('standalone calls retain arguments propagation fallback and one deletion control in semantic views', { timeout: 90000 }, async () => {
    const source = 'let^run=p^{plain(17) try^risky(19) maybe(23)??backup(29) after(31)}';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), fn = tree.root.fields.items[0].fields.values[0], statements = fn.fields.body.fields.items;
        assert.deepEqual(statements.map(n => n.kind), ['call-stmt','call-stmt','call-stmt','call-stmt']);
        await browser({ ...routes, '/': { type:'text/html', body:html(tree, false) } }, async client => {
            const normal = (await svgTexts(client)).join(''); assert(normal.includes('run')); assert(normal.includes(ja.Procedure));
            const check = async () => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const number of ['17','19','23','29','31']) assert.equal(texts.filter(t => t === number).length, 1, text);
                for (const name of ['plain','risky','maybe','backup','after']) assert(text.includes(name), name + ': ' + text);
                assert.equal(texts.filter(t => t === ja.Call).length, 5, text);
                assert(text.includes(ja['Propagate error']), text); assert(texts.includes('??'), text);
                for (const node of statements) assert.equal(await client.evaluate(`document.querySelectorAll('.element-delete[data-delete-start="${node.start}"][data-delete-end="${node.end}"]').length`), 1, source.slice(node.start, node.end));
                const fallback = statements[2];
                const route = await client.evaluate(`(()=>{
                    const row=document.querySelector('.operator-expression[data-source-start="${fallback.start}"][data-source-end="${fallback.end}"]');
                    const handle=row.closest('.react-flow__node').querySelector('[data-handleid="flow-out"]').getBoundingClientRect();
                    const paths=[...document.querySelectorAll('.react-flow__edge-execution .react-flow__edge-path,.react-flow__edge-execution-bypass .react-flow__edge-path')];
                    const path=paths.find(p=>{const point=p.getPointAtLength(0),screen=new DOMPoint(point.x,point.y).matrixTransform(p.getScreenCTM());return Math.hypot(screen.x-handle.left-handle.width/2,screen.y-handle.bottom)<3});
                    if(!path)return {collisions:-1,handle:{x:handle.left+handle.width/2,y:handle.top+handle.height/2},paths:paths.map(p=>{const point=p.getPointAtLength(0),screen=new DOMPoint(point.x,point.y).matrixTransform(p.getScreenCTM());return {x:screen.x,y:screen.y,kind:p.parentElement.getAttribute('class')}})};
                    const obstacles=[...document.querySelectorAll('.call-node,.literal-node')].map(n=>n.getBoundingClientRect());
                    let collisions=0;
                    for(let distance=0;distance<=path.getTotalLength();distance+=2){const point=path.getPointAtLength(distance),screen=new DOMPoint(point.x,point.y).matrixTransform(path.getScreenCTM());if(obstacles.some(r=>screen.x>r.left+1&&screen.x<r.right-1&&screen.y>r.top+1&&screen.y<r.bottom-1))collisions++}
                    return {collisions};
                })()`);
                assert(route, 'The standalone fallback must have a continuation');
                assert.equal(route.collisions, 0, 'Continuation must pass outside the extracted operands: ' + JSON.stringify(route));
            };
            await graphToolbar(client, 'Unfold All'); await check(); await saveSemanticSvg(client, 'standalone-calls');
            await graphToolbar(client, 'Fold All'); assert((await svgTexts(client)).join('').includes('run'));
            await drillGraphNode(client, fn); await graphToolbar(client, 'Unfold All'); await check();
            await graphToolbar(client, 'A+'); await check();
            await graphToolbar(client, 'Fold All'); await drillGraphNode(client, statements[2]); await graphToolbar(client, 'Unfold All');
            const isolated = await svgTexts(client), isolatedText = isolated.join('');
            for (const value of ['maybe','backup','23','29','??']) assert(isolatedText.includes(value), isolatedText);
            for (const value of ['17','19','31']) assert(!isolated.includes(value), isolatedText);
            assert.equal(isolated.filter(t => t === ja.Call).length, 2);
            assert.equal(await client.evaluate('window.edits.length'), 0); assert.deepEqual(client.errors, []);
        });
    });
});

test('yield and await result expressions and phantom payload lists edit through live procedure controls', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^procedure=p^{let^value=(_yield^(0,0))}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), fn = () => host.tree.root.fields.items[0].fields.values[0];
            const binding = () => fn().fields.body.fields.items[0], value = () => binding().fields.values[0];
            await ui.add('procedure');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.add('let', fn().fields.body);
            await ui.expression(value(), 'yield');
            await ui.structure(value(), 'yield:phantom');
            await ui.addElement('number', value(), 'value');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.remove(value().fields.value[1]);
            await ui.expression(value(), 'unwrap');
            await ui.expression(value(), 'await');
            assert.equal(value().kind, 'await');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('let^procedure=p^{let^value=await^(0)}')));
            await ui.expression(value(), 'nil');
            assert.equal(value().kind, 'hat-ident');
            await ui.add('yield', fn().fields.body);
            const statement = () => fn().fields.body.fields.items[1];
            await ui.structure(statement(), 'yield:phantom');
            const payload = () => Array.isArray(statement().fields?.value) ? statement().fields.value : [statement().fields.value];
            await ui.remove(payload()[0]);
            assert(!statement().fields?.value);
            await ui.addElement('number', statement(), 'value');
            assert.equal(statement().kind, 'yield');
            assert.match(host.tree.source, /_yield\^\s*0/);
            await ui.remove(statement());
            await ui.add('await', fn().fields.body);
            const awaited = () => statement().fields.value.fields.value;
            await ui.expression(awaited(), 'number');
            await ui.input(`.box[data-source-start="${awaited().start}"] .literal-input`, '41');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('let^procedure=p^{let^value=nil^ await^41}')));
            await ui.remove(statement()); await ui.add('await', fn().fields.body); await ui.remove(statement());
            await ui.remove(binding()); await ui.remove(host.tree.root.fields.items[0]);
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('yield and await views distinguish sent values received bindings delegation and phantom suspension', { timeout: 90000 }, async () => {
    const source = 'let^run=p^{yield^17,19 _yield^23 await^worker(29) let^received=yield^31 let^answer=await^worker(37)} let^outside=41';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), flat = n => [n,...Object.values(n.fields ?? {}).flat().flatMap(flat)];
        assert(!flat(tree.root).some(n => n.kind === 'error'), source);
        await browser({ ...routes, '/':{type:'text/html',body:html(tree,false)} }, async client => {
            assert((await svgTexts(client)).join('').includes('run'));
            const check = async inside => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const number of ['17','19','23','29','31','37']) assert.equal(texts.filter(t => t === number).length, 1, text);
                assert.equal(texts.filter(t => t === '41').length, inside ? 0 : 1, text);
                for (const value of ['received','answer','worker',ja.Yield,ja.Suspend,ja.Await]) assert(text.includes(value), value + ': ' + text);
            };
            await graphToolbar(client, 'Unfold All'); await check(false); await saveSemanticSvg(client, 'yield-await');
            await graphToolbar(client, 'Fold All'); assert((await svgTexts(client)).join('').includes('run'));
            await drillGraphNode(client, tree.root.fields.items[0].fields.values[0]);
            await graphToolbar(client, 'Unfold All'); await check(true);
            assert.equal(await client.evaluate('window.edits.length'), 0); assert.deepEqual(client.errors, []);
        });
    });
});

test('member declarations create quoted paths and toggle existing-member assignment through live menus', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('var^table.`a.b`:=0'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), node = () => host.tree.root.fields.items[0];
            await ui.add('var');
            await ui.structure(node(), 'binding:target:0:table.`a.b`');
            await ui.structure(node(), 'binding:existing');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.match(await client.evaluate(`document.querySelector('.box[data-source-start="${node().start}"][data-source-end="${node().end}"]').textContent`), /:=/);
            await ui.structure(node(), 'binding:existing');
            assert(!host.tree.source.includes(':='));
            await ui.structure(node(), 'binding:target:0:local');
            await ui.structure(node(), 'binding:existing');
            await ui.structure(node(), 'mutability');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('let^local=0')));
            await ui.remove(node());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('nested loop transfers are created, retargeted and deleted through live graph menus', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('repeat^1 {repeat^1 {next^^}}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), outer = () => host.tree.root.fields.items[0];
            const inner = () => outer().fields.body.fields.items[0], jump = () => inner().fields.body.fields.items[0];
            await ui.add('repeat');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.add('repeat', outer().fields.body);
            await ui.add('break', inner().fields.body);
            await ui.structure(jump(), 'jump:break:2');
            assert.match(host.tree.source, /break\^\^/);
            await ui.structure(jump(), 'jump:next:2');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.match(await client.evaluate(`document.querySelector('.box[data-source-start="${jump().start}"][data-source-end="${jump().end}"]').textContent`), /2/);
            await ui.structure(jump(), 'jump:next:1');
            assert.equal(host.tree.source.slice(jump().start, jump().end), 'next^');
            await ui.remove(jump());
            assert.equal(inner().fields.body.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('loop controls edit focus initialization, advance, direction and step through the live document', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'var^m=5');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), loop = () => host.tree.root.fields.items[1];
            await ui.add('for');
            await ui.input(`.name-input[data-reference-start="${loop().fields.focus[0].fields.targets[0].start}"]`, 'm');
            await ui.add('call', loop().fields.body);
            const body = host.tree.source.slice(loop().fields.body.start, loop().fields.body.end);
            await ui.structure(loop(), 'mode:while');
            await ui.structure(loop(), 'focus:existing');
            assert.equal(loop().fields.focus[0].kind, 'reassign');
            await ui.structure(loop(), 'next:remove'); assert(!loop().fields.advance);
            await ui.structure(loop(), 'next:add'); assert.equal(loop().fields.advance.length, 1);
            await ui.structure(loop(), 'focus:mutable'); assert.equal(loop().fields.focus[0].kind, 'define');
            await ui.structure(loop(), 'mode:range');
            await ui.structure(loop(), 'direction'); assert(host.tree.source.includes('downto^'));
            await ui.structure(loop(), 'step:add'); assert(host.tree.source.includes('step^1'));
            await ui.structure(loop(), 'step:remove'); assert(!host.tree.source.includes('step^'));
            assert.equal(host.tree.source.slice(loop().fields.body.start, loop().fields.body.end), body);
            await ui.remove(loop()); await ui.add('repeat'); await ui.remove(loop());
            await ui.add('for'); await ui.remove(loop());
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('var^m=5')));
            assert.deepEqual(client.errors, []);
        });
    });
});

test('loops sample is reconstructed through loop modes, sections, comments and live expression edits', { timeout: 300000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/loops.lh'), 'utf8').replace(/\r\n/g, '\n');
        const expected = normalizedAst(await parse(source)), host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), items = () => host.tree.root.fields.items;
            const literal = (node, text) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, text);
            const rename = async (node, text) => {
                if (host.tree.source.slice(node.start, node.end) !== text) await ui.input(`.name-input[data-reference-start="${node.start}"]`, text);
            };
            const comment = async text => {
                await ui.add('comment'); const start = host.tree.source.lastIndexOf('#');
                await ui.input(`.comment-box[data-source-start="${start}"] textarea`, text);
            };
            const bodyComment = async (loop, text) => {
                await ui.structure(loop(), 'body:comment');
                await ui.input(`.comment-box[data-source-start="${loop().fields.body.comments[0].start}"] textarea`, text);
            };
            const define = async (kind, name, value) => {
                await ui.add(kind); const index = items().length - 1;
                await rename(items()[index].fields.targets[0], name);
                if (value !== 0) await literal(items()[index].fields.values[0], String(value));
            };
            const sequence = owner => owner.kind === 'loop-clause' ? owner.fields?.body ?? [] : owner.fields?.items ?? [];
            const print = async (owner, text, variable) => {
                await ui.add('call', owner()); const index = sequence(owner()).length - 1;
                const value = () => sequence(owner())[index].fields.value.fields.argument[0];
                await ui.expression(value(), variable ? 'interpolation' : 'string');
                if (!variable) { await literal(value(), text); return; }
                const selectors = '.interpolation-field.text textarea';
                const last = await client.evaluate(`document.querySelectorAll(${JSON.stringify(selectors)}).length-1`);
                await ui.input(selectors, text, last);
                const hole = value().fields.items.find(n => n.kind === 'interp-hole');
                await ui.expression(hole.fields.value, `reference:${variable}`);
            };
            const assignment = async (owner, name, operator = ':=', value = 0) => {
                await ui.add('assign', owner()); const index = sequence(owner()).length - 1;
                const node = () => sequence(owner())[index];
                await ui.expression(node().fields.targets[0], `reference:${name}`);
                if (value !== 0) await literal(node().fields.values[0], String(value));
                if (operator !== ':=') await ui.structure(node(), `assignment:${operator}`);
            };
            const repeat = async (mode, title) => {
                if (title) await comment(title);
                await ui.add('repeat'); const index = items().length - 1, loop = () => items()[index];
                if (mode) await ui.structure(loop(), `mode:${mode}`);
                return loop;
            };
            const condition = async (loop, name, operator, limit) => {
                await ui.expression(loop().fields.bound, `reference:${name}`);
                await ui.expression(loop().fields.bound, 'compare'); await ui.operator(loop().fields.bound, operator);
                await literal(loop().fields.bound.fields.right, String(limit));
            };
            const sections = async loop => {
                for (const name of ['pre', 'first', 'last', 'epilog']) await ui.structure(loop(), `section:${name}^`);
            };
            const section = (loop, name) => () => name === 'main' ? loop().fields.body
                : loop().fields.body.fields.extra.find(n => host.tree.source.slice(n.start, n.end).startsWith(`${name}^`));
            const range = async (name, limit, title) => {
                if (title) await comment(title);
                await ui.add('for'); const index = items().length - 1, loop = () => items()[index];
                await rename(loop().fields.focus[0].fields.targets[0], name);
                await literal(loop().fields.focus[0].fields.values[0], '0'); await literal(loop().fields.bound, String(limit));
                return loop;
            };
            const first = await repeat('forever', 'Infinity loop');
            await print(() => first().fields.body, 'infinity loop'); await ui.add('break', first().fields.body);
            const second = await repeat('forever');
            await print(() => second().fields.body, 'infinity loop'); await ui.add('if', second().fields.body);
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await client.until(`!document.querySelector('.svg-export>button').disabled`);
            const branch = () => second().fields.body.fields.items[1].fields.items[0];
            await ui.expression(branch().fields.condition, 'string'); await literal(branch().fields.condition, 'aaaaa');
            await ui.expression(branch().fields.condition, 'compare'); await ui.expression(branch().fields.condition.fields.right, 'string');
            await literal(branch().fields.condition.fields.right, 'aaaaa'); await ui.add('break', branch().fields.body);
            await define('let', 'n', 4);
            const fixed = await repeat(undefined, 'Fixed time loop');
            await ui.expression(fixed().fields.bound, 'reference:n'); await ui.expression(fixed().fields.bound, 'add');
            await literal(fixed().fields.bound.fields.right, '1'); await sections(fixed);
            await print(() => fixed().fields.body, 'fixed time loop');
            await define('var', 'ii', 5);
            const ii = await repeat(); await ui.expression(ii().fields.bound, 'reference:ii');
            await bodyComment(ii, '繰り返し数は開始時で固定');
            await print(() => ii().fields.body, 'fixed time loop ', 'ii'); await assignment(() => ii().fields.body, 'ii', '+=', 1);
            await define('var', 'm', 0);
            const whileLoop = await repeat('while', 'While loop (without loop variable)');
            await condition(whileLoop, 'm', '<', 5); await print(() => whileLoop().fields.body, 'repeat^while^ loop : ', 'm');
            await assignment(() => whileLoop().fields.body, 'm', '+=', 1);
            await assignment(() => host.tree.root, 'm');
            const untilLoop = await repeat('until', 'Until loop (without loop variable)');
            await condition(untilLoop, 'm', '>', 4); await print(() => untilLoop().fields.body, 'repeat^until^ loop : ', 'm');
            await assignment(() => untilLoop().fields.body, 'm', '+=', 1);
            const existing = await range('m', 5, 'While loop ');
            await ui.structure(existing(), 'mode:while'); await ui.structure(existing(), 'focus:existing');
            await ui.structure(existing(), 'next:remove'); await condition(existing, 'm', '<', 5);
            await print(() => existing().fields.body, 'for^while^ loop : ', 'm'); await assignment(() => existing().fields.body, 'm', '+=', 1);
            const advancing = await range('m', 5);
            await ui.structure(advancing(), 'mode:while'); await ui.structure(advancing(), 'focus:existing');
            await condition(advancing, 'm', '<', 5); await print(() => advancing().fields.body, 'for^while^next^ loop : ', 'm');
            const scoped = await range('l', 5, 'While loop ');
            await ui.structure(scoped(), 'mode:while'); await condition(scoped, 'l', '<', 5); await sections(scoped);
            for (const name of ['pre', 'first', 'main', 'last', 'epilog']) await print(section(scoped, name), `for^var^while^next^ ${name} : `, 'l');
            const numeric = await range('i', 5, 'Number Range Loop'); await print(() => numeric().fields.body, 'for^from^to^ loop');
            const fractional = await range('i', 5.4, 'Number Range Loop');
            await bodyComment(fractional, 'これ許されるんだ…いや、利便性のためには妥当か。'); await sections(fractional);
            for (const name of ['pre', 'first', 'main', 'last', 'epilog']) await print(section(fractional, name), `Number Range Loop ${name}${name === 'main' ? ' ' : ' : '}`, 'i');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('patterns sample is reconstructed with named focus, editable alternatives, ranges and type patterns', { timeout: 180000 }, async () => {
    const { graphHost, graphUi, normalizedAst, load } = require('./graph-browser-host.cjs');
    const patterns = load('graphPatterns.ts');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/patterns.lh'), 'utf8').replace(/\r\n/g, '\n');
        const expected = normalizedAst(await parse(source)), host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), items = () => host.tree.root.fields.items;
            const literal = (node, text) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, text);
            const rename = (node, text) => ui.input(`.name-input[data-reference-start="${node.start}"]`, text);
            const comment = async text => {
                await ui.add('comment'); await ui.input(`.comment-box[data-source-start="${host.tree.source.lastIndexOf('#')}"] textarea`, text);
            };
            const fn = async (kind, name, parameter, type, text) => {
                await comment(text); await ui.add(kind); const index = items().length - 1;
                await rename(items()[index].fields.targets[0], name);
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await client.until(`!document.querySelector('.svg-export>button').disabled`);
                const value = () => items()[index].fields.values[0];
                await ui.addElement('parameter', value(), 'params'); await rename(value().fields.params[0].fields.name, parameter);
                await ui.type(value().fields.params[0].fields.name, type); return value;
            };
            const list = branch => patterns.patternLists(host.tree).find(p => p.clause.start === branch.start);
            const result = async (branch, text) => {
                await ui.add('return', branch().fields.body);
                const returned = () => branch().fields.body.fields.items[0];
                await ui.addElement('string', returned(), 'value'); await literal(returned().fields.value[0], text);
            };
            await ui.add('module'); await ui.input('.interpolation-field.module textarea', 'examples.patterns');
            const describe = await fn('procedure', 'describe', 'kind', 'string^', 'The focus is evaluated once; the clauses share one execution junction.');
            await ui.add('match', describe().fields.body);
            const match = () => describe().fields.body.fields.items[0], branch = i => match().fields.body.fields.items[i];
            await ui.structure(match(), 'focus:bind');
            await ui.expression(match().fields.focus[0].fields.values[0], 'reference:kind');
            await ui.structure(match(), 'match-branch'); await ui.structure(match(), 'match-branch');
            for (const [index, text] of ['item', 'box', 'pallet'].entries()) {
                await ui.structure(match(), `pattern:${index}:string`);
                await literal(list(branch(index)).items[0], text);
                if (index === 1) {
                    await ui.addElement('string', list(branch(index)).node);
                    await literal(list(branch(index)).items[1], 'carton');
                }
                await result(() => branch(index), text);
            }
            await result(() => branch(3), 'unknown');
            const classify = await fn('procedure', 'classify', 'n', 'number^', 'Range/type patterns retain their source spelling in the clause header.');
            await ui.add('match', classify().fields.body);
            const matching = () => classify().fields.body.fields.items[0], arm = i => matching().fields.body.fields.items[i];
            await ui.expression(matching().fields.focus[0].fields.values[0], 'reference:n');
            await ui.structure(matching(), 'match-branch'); await ui.structure(matching(), 'match-branch');
            await result(() => arm(0), 'zero');
            await ui.structure(matching(), 'pattern:1:range');
            await literal(list(arm(1)).items[0].fields.lower, '1'); await literal(list(arm(1)).items[0].fields.upper, '3');
            await ui.addElement('number', list(arm(1)).node); await literal(list(arm(1)).items[1], '5');
            await result(() => arm(1), 'small');
            await ui.structure(matching(), 'pattern:2:type'); await result(() => arm(2), 'number'); await result(() => arm(3), 'other');
            const expression = await fn('function', 'expression', 'n', 'number^', 'Expression matches do not acquire statement execution lines.');
            const returned = () => expression().fields.body.fields.items[0], value = () => returned().fields.value[0];
            await ui.expression(value(), 'match'); await ui.expression(value().fields.focus[0].fields.values[0], 'reference:n');
            for (const [index, text] of ['zero', 'other'].entries()) {
                await ui.expression(value().fields.body.fields.items[index].fields.body, 'string');
                await literal(value().fields.body.fields.items[index].fields.body, text);
            }
            await ui.structure(returned(), 'return:implicit');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('real pattern alternatives show only written values and support deletion followed by insertion', { timeout: 60000 }, async () => {
    const { graphHost, graphUi, load } = require('./graph-browser-host.cjs'), patterns = load('graphPatterns.ts');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'for^n{when^1 to^3,5:print(1) other^:print(2)}');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), list = () => patterns.patternLists(host.tree)[0];
            await client.until(`document.querySelector('.svg-export>button') && !document.querySelector('.svg-export>button').disabled`);
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await client.until(`document.querySelectorAll('.literal-input').length===5 && !document.querySelector('.svg-export>button').disabled`);
            await ui.remove(list().items[0]);
            assert.equal(list().items.length, 1);
            assert.equal(host.tree.source.slice(list().items[0].start, list().items[0].end), '5');
            await ui.addElement('string', list().node);
            await ui.input(`.box[data-source-start="${list().items[1].start}"] .literal-input`, 'other');
            assert(host.tree.source.includes('when^5, "other":'));
            assert.deepEqual(client.errors, []);
        });
    });
});

test('type patterns expose editable type structure and table member declarations through the live UI', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst, load } = require('./graph-browser-host.cjs'), patterns = load('graphPatterns.ts');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('for^nil^{when^fits^t^{item:string^}: other^:}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), match = () => host.tree.root.fields.items[0];
            const pattern = () => patterns.patternLists(host.tree)[0].items[0], type = () => pattern().fields.type;
            await ui.add('match');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await client.until(`!document.querySelector('.svg-export>button').disabled`);
            await ui.structure(match(), 'pattern:0:type');
            await ui.structure(type(), 'type:name:t^{}');
            await ui.addElement('typeMember', type());
            const key = () => type().fields.items[0].fields.key;
            await ui.input(`.name-input[data-reference-start="${key().start}"]`, 'item');
            await ui.typeStructure(key(), 'type:name:string^');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.remove(type().fields.items[0]);
            assert.equal(type().fields?.items?.length ?? 0, 0);
            await ui.structure(type(), 'type:name:number^');
            await ui.structure(type(), 'type:nullable');
            assert.equal(type().kind, 'type-union');
            await ui.structure(match(), 'pattern:0:range');
            assert.equal(pattern().kind, 'pattern-range');
            const alternatives = () => patterns.patternLists(host.tree)[0];
            await ui.addElement('typePattern', alternatives().node);
            await ui.addElement('rangePattern', alternatives().node);
            assert.deepEqual(alternatives().items.map(n => n.kind), ['pattern-range', 'pattern-type', 'pattern-range']);
            await ui.structure(alternatives().items[1].fields.type, 'type:name:string^');
            await ui.remove(alternatives().items[0]);
            assert.deepEqual(alternatives().items.map(n => n.kind), ['pattern-type', 'pattern-range']);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('nested table patterns are built, edited and deleted with shared expression and list controls', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst, load } = require('./graph-browser-host.cjs'), patterns = load('graphPatterns.ts');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('for^nil^{when^{child={key=2}}: other^:}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), list = () => patterns.patternLists(host.tree)[0];
            const table = () => list().items[0], entry = () => table().fields.items[0];
            await ui.add('match');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await client.until(`!document.querySelector('.svg-export>button').disabled`);
            await ui.expression(table(), 'table');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.addElement('member', table());
            await ui.input(`.name-input[data-reference-start="${entry().fields.key.start}"]`, 'child');
            await ui.expression(entry().fields.value, 'table');
            await ui.addElement('member', entry().fields.value);
            const nested = () => entry().fields.value.fields.items[0];
            await ui.input(`.name-input[data-reference-start="${nested().fields.key.start}"]`, 'key');
            await ui.input(`.box[data-source-start="${nested().fields.value.start}"] .literal-input`, '2');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.remove(nested());
            assert.equal(entry().fields.value.fields?.items?.length ?? 0, 0);
            await ui.addElement('number', entry().fields.value);
            assert.equal(entry().fields.value.fields.items.length, 1);
            await ui.addElement('number', list().node);
            await ui.remove(table());
            assert.equal(list().items.length, 1);
            assert.equal(list().items[0].kind, 'int');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('type labels construct named, sequence and nullable types through the live source', { timeout: 90000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), items = () => host.tree.root.fields.items;
            await ui.add('tableDefinition');
            await ui.add('procedure');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await client.until(`!document.querySelector('.svg-export>button').disabled`);
            const fn = () => items()[1].fields.values[0];
            await ui.addElement('parameter', fn(), 'params');
            const name = () => fn().fields.params[0].fields.name;
            await ui.typeStructure(name(), 'type:name:Item');
            assert.equal(fn().fields.params[0].fields.type.kind, 'type-name');
            await ui.typeStructure(name(), 'type:sequence');
            assert.equal(fn().fields.params[0].fields.type.kind, 'type-table');
            await ui.typeStructure(name(), 'type:nullable');
            assert.equal(fn().fields.params[0].fields.type.kind, 'type-union');
            const annotation = fn().fields.params[0].fields.type;
            assert.equal(annotation.fields.left.kind, 'type-table');
            assert.equal(host.tree.source.slice(annotation.fields.right.start, annotation.fields.right.end), 'nil^');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('iterator loop names rename through LSP and key selection preserves the live body', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, load } = require('./graph-browser-host.cjs'), loops = load('graphLoops.ts');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'let^items={1,2}');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), loop = () => host.tree.root.fields.items[1];
            const names = () => loops.iteratorNames(loop(), host.tree.source);
            await ui.add('for'); await ui.structure(loop(), 'mode:iterator');
            await ui.expression(loop().fields.bound, 'reference:items');
            await ui.input(`.name-input[data-reference-start="${names()[0].start}"]`, 'entry');
            await ui.add('call', loop().fields.body);
            await ui.expression(loop().fields.body.fields.items[0].fields.value.fields.argument[0], 'reference:entry');
            await ui.input(`.name-input[data-reference-start="${names()[0].start}"]`, 'item');
            assert(host.tree.source.includes('print(item)'));
            await ui.structure(loop(), 'iterator:key:add'); assert.equal(names().length, 2);
            await ui.input(`.name-input[data-reference-start="${names()[0].start}"]`, 'index');
            await ui.structure(loop(), 'iterator:key:remove'); assert.equal(names().length, 1);
            assert(host.tree.source.includes('print(item)'));
            assert.deepEqual(client.errors, []);
        });
    });
});

test('focused conditional statements are created with one editable predicate and live local bindings', { timeout: 60000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('for^let^delta=7 if^delta>0{print(delta)}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), focused = () => host.tree.root.fields.items[0];
            await ui.add('focusedIf');
            await ui.input(`.name-input[data-reference-start="${focused().fields.focus[0].fields.targets[0].start}"]`, 'delta');
            await ui.input(`.box[data-source-start="${focused().fields.focus[0].fields.values[0].start}"] .literal-input`, '7');
            const branch = () => focused().fields.body.fields.items[0];
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await client.until(`!document.querySelector('.svg-export>button').disabled`);
            await ui.expression(branch().fields.condition, 'reference:delta'); await ui.expression(branch().fields.condition, 'compare');
            await ui.operator(branch().fields.condition, '>'); await ui.add('call', branch().fields.body);
            await ui.expression(branch().fields.body.fields.items[0].fields.value.fields.argument[0], 'reference:delta');
            assert.equal(await client.evaluate(`document.querySelectorAll('.condition-node').length`), 1);
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('a typed variadic function is constructed through parameter, reference and index controls', { timeout: 60000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^first=f^...:number^{...[0]}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), declaration = () => host.tree.root.fields.items[0];
            const fn = () => declaration().fields.values[0], returned = () => fn().fields.body.fields.items[0];
            await ui.add('function');
            await ui.input(`.name-input[data-reference-start="${declaration().fields.targets[0].start}"]`, 'first');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await client.until(`!document.querySelector('.svg-export>button').disabled`);
            await ui.addElement('variadic', fn(), 'params');
            const variadic = fn().fields.params[0];
            await ui.typeStructure({ start: variadic.start, end: variadic.start + 3 }, 'type:name:number^');
            assert(returned()?.fields?.value?.length, host.tree.source);
            await ui.expression(returned().fields.value[0], 'reference:...');
            await ui.expression(returned().fields.value[0], 'index');
            await ui.structure(returned(), 'return:implicit');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('quoted declarations and member references are reconstructed and remain renameable through live graph controls', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        const expected = normalizedAst(await parse('let^`a``b`={`a.b`=0} print(`a``b`.`a.b`)'));
        await browser({ ...routes, '/': { type:'text/html', body:html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), definition = () => host.tree.root.fields.items[0];
            const target = () => definition().fields.targets[0], table = () => definition().fields.values[0];
            const rename = async name => ui.input(`.name-input[data-reference-start="${target().start}"]`, name);
            await ui.add('let');
            await rename('`display name`');
            await ui.expression(table(), 'table');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.addElement('member', table());
            const key = table().fields.items[0].fields.key;
            await ui.input(`.name-input[data-reference-start="${key.start}"]`, '`a.b`');
            await ui.add('call');
            const argument = () => host.tree.root.fields.items[1].fields.value.fields.argument[0];
            await ui.expression(argument(), 'reference:`display name`.`a.b`');
            await rename('`a``b`');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await rename('normal');
            assert(host.tree.source.includes('print(normal.`a.b`)'), host.tree.source);
            await rename('`日本 語`');
            assert(host.tree.source.includes('print(`日本 語`.`a.b`)'), host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('quoted type member names, qualified types and error alternatives are editable in their live menus', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        const expected = normalizedAst(await parse('let^function=f^value:`module name`.`a.b`{return^0} do^{catch^`problem|name`.`bad state`|Other:}'));
        await browser({ ...routes, '/': { type:'text/html', body:html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), fn = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('function');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.addElement('parameter', fn(), 'params');
            const name = () => fn().fields.params[0].fields.name;
            await ui.typeStructure(name(), 'type:name:t^{}');
            await ui.typeStructure(name(), 'type:append:items');
            await ui.typeStructure(name(), 'type:rename:0:`a.b`');
            assert(host.tree.source.includes('`a.b`: number^'), host.tree.source);
            await ui.typeStructure(name(), 'type:reference:`module name`.`a.b`');
            await ui.add('block');
            const block = () => host.tree.root.fields.items[1];
            await ui.structure(block(), 'catch:all');
            await ui.structure(block().fields.arms[0], 'catch:filter:`problem|name`.`bad state`|Other');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('cleanup transfer ports survive folding and drilling and export dashed links as standalone SVG', { timeout: 90000 }, async () => {
    const source = require('./graph-language-cases.cjs').languageCases().find(c => c.name === 'cleanup-transfer').source;
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), fn = tree.root.fields.items[0].fields.values[0];
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree) } }, async ({ evaluate, until, call, errors }) => {
            const ready = `!document.querySelector('.svg-export>button').disabled`;
            await until(`document.querySelector('#app')?.dataset.graphVersion==='1' && ${ready}`);
            await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await until(`document.querySelector('.react-flow__edge.cleanup path') && ${ready}`);
            assert(await evaluate(`!!document.querySelector('[data-handleid="flow-cleanup"]')`));
            await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Fold All')?.click()`);
            await until(`document.querySelector('.box.folded[data-source-start="${fn.start}"]') && !document.querySelector('.react-flow__edge.cleanup') && ${ready}`);
            const point = await evaluate(`(()=>{const r=document.querySelector('.box.folded[data-source-start="${fn.start}"]').getBoundingClientRect();return {x:r.left+12,y:r.top+12}})()`);
            for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent', { type, ...point, button:'left', clickCount:1 });
            await until(`document.querySelector('#trail') && ${ready}`);
            await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await until(`document.querySelector('.react-flow__edge.cleanup path') && ${ready}`);
            const geometry = await evaluate(`(()=>{const e=document.querySelector('.react-flow__edge.cleanup path');return {d:e.getAttribute('d'),dash:getComputedStyle(e).strokeDasharray}})()`);
            assert(!/NaN|undefined|Infinity/.test(geometry.d));
            assert(geometry.dash !== 'none');
            await evaluate(`document.querySelector('.svg-export>button').click()`);
            await until(`document.querySelector('.svg-export-menu>button')`);
            await evaluate(`document.querySelector('.svg-export-menu>button').click()`);
            await until(`window.exports.length===1`);
            const exported = await evaluate(`(()=>{const doc=new DOMParser().parseFromString(window.exports[0].svg,'image/svg+xml');return {error:!!doc.querySelector('parsererror'),dash:[...doc.querySelectorAll('path')].some(p=>p.getAttribute('stroke-dasharray')?.includes('4'))}})()`);
            assert(!exported.error && exported.dash);
            const screenshot = await call('Page.captureScreenshot', { format:'png' });
            fs.writeFileSync(path.join(require('node:os').tmpdir(), 'lhat-finally-transfer.png'), Buffer.from(screenshot.data, 'base64'));
            await call('Input.dispatchMouseEvent', { type:'mouseWheel', x:500, y:400, deltaY:500, deltaX:0 });
            await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
            const tail = await call('Page.captureScreenshot', { format:'png' });
            fs.writeFileSync(path.join(require('node:os').tmpdir(), 'lhat-finally-transfer-tail.png'), Buffer.from(tail.data, 'base64'));

            assert.equal(await evaluate(`window.edits.length`), 0);
            assert.deepEqual(errors, []);
        });
    });
});

test('if, callable, with and loop handler menus remain reachable after real source refreshes', { timeout: 120000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client);
            for (const template of ['if','function','with','repeat']) {
                await ui.add(template);
                const owner = () => template === 'function' ? host.tree.root.fields.items.at(-1).fields.values[0] : host.tree.root.fields.items.at(-1);
                const scope = () => ['func','repeat'].includes(owner().kind) ? owner().fields.body : owner().kind === 'with' ? owner().fields.extra[0] : owner();
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await ui.structure(owner(), 'catch:all');
                await ui.structure(owner(), 'catch:add');
                await ui.structure(scope().fields.arms[0], 'catch:filter:Problem.Failure');
                await ui.add('call', scope().fields.arms[0].fields.body);
                await ui.structure(owner(), template === 'repeat' ? 'section:finally^' : 'finally:add');
                await ui.add('call', scope().fields.extra.at(-1));
                assert.equal(scope().fields.arms.length, 2, host.tree.source);
                const descendants = node => [node, ...Object.values(node.fields ?? {}).flat().flatMap(descendants)];
                assert(descendants(scope().fields.arms[0].fields.body).some(node => node.kind === 'call'), host.tree.source);
                await ui.remove(scope().fields.arms[0]);
                await ui.remove(scope().fields.arms[0]);
                assert.equal(scope().fields.arms?.length ?? 0, 0);
                await ui.remove(scope().fields.extra.at(-1));
                assert.equal(scope().fields?.extra?.length ?? 0, 0);
            }
            assert.deepEqual(client.errors, []);
        });
    });
});

test('return values and panic payloads rebuild after deletion through live controls', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/':{type:'text/html',body:html(host.tree,false)} }, async client => {
            const ui = await graphUi(host, client), fn = () => host.tree.root.fields.items[0].fields.values[0];
            const result = () => fn().fields.body.fields.items[0];
            const literal = (node, text) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, text);
            await ui.add('function'); await graphToolbar(client, 'Unfold All');
            await literal(result().fields.value[0], '17');
            await ui.structure(result(), 'return:implicit');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('let^function=f^{17}')));
            await ui.structure(result(), 'return:explicit');
            await ui.addElement('number', result(), 'value'); await literal(result().fields.value[1], '23');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('let^function=f^{return^17,23}')));
            await ui.remove(result().fields.value[0]); await ui.remove(result().fields.value[0]);
            assert(!result().fields?.value);
            await ui.addElement('number', result(), 'value'); await literal(result().fields.value[0], '31');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('let^function=f^{return^31}')));
            await ui.remove(result()); await ui.add('return', fn().fields.body);
            await ui.remove(host.tree.root.fields.items[0]);
            await ui.add('panic');
            const panic = () => host.tree.root.fields.items[0];
            await literal(panic().fields.value, 'fatal detail');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('panic^"fatal detail"')));
            await ui.expression(panic().fields.value, 'number'); await literal(panic().fields.value, '37');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('panic^37')));
            await ui.remove(panic()); await ui.add('panic'); await ui.remove(panic());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('return and loop transfer views retain payloads destinations and fatal values', { timeout: 90000 }, async () => {
    const source = 'let^compute=f^{if^guard(17){return^19,23} return^29} let^implicit=f^{31} let^flow=p^{repeat^37{repeat^41{if^test(43){break^^} next^}} panic^47}';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), flat = n => [n,...Object.values(n.fields ?? {}).flat().flatMap(flat)];
        assert(!flat(tree.root).some(n => n.kind === 'error'), source);
        const numbers = ['17','19','23','29','31','37','41','43','47'];
        await browser({ ...routes, '/':{type:'text/html',body:html(tree,false)} }, async client => {
            const initial = (await svgTexts(client)).join('');
            for (const name of ['compute','implicit','flow']) assert(initial.includes(name));
            const check = async selected => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const number of numbers) assert.equal(texts.filter(t => t === number).length, selected.includes(number) ? 1 : 0, text);
                return text;
            };
            await graphToolbar(client, 'Unfold All');
            const text = await check(numbers);
            for (const label of [ja.Break,ja['Next iteration'],ja['Raise fatal error']]) assert(text.includes(label), label + ': ' + text);
            assert.equal(await client.evaluate('document.querySelectorAll(".return-icon").length'), 3);
            await saveSemanticSvg(client, 'return-loop-transfers');
            await graphToolbar(client, 'Fold All'); await drillGraphNode(client, tree.root.fields.items[0].fields.values[0]);
            await graphToolbar(client, 'Unfold All'); await check(numbers.slice(0,4));
            assert.equal(await client.evaluate('document.querySelectorAll(".return-icon").length'), 2);
            await client.evaluate('document.querySelector("#trail button").click()'); await graphToolbar(client);
            await graphToolbar(client, 'Fold All'); await drillGraphNode(client, tree.root.fields.items[2].fields.values[0]);
            await graphToolbar(client, 'Unfold All'); await check(numbers.slice(5));
            const jumps = flat(tree.root).filter(n => ['break','next'].includes(n.kind));
            for (const jump of jumps) {
                const caption = await client.evaluate(`document.querySelector('.box[data-source-start="${jump.start}"][data-source-end="${jump.end}"]').textContent`);
                assert(caption.includes(ja[jump.kind === 'break' ? 'Break' : 'Next iteration']), caption);
                if (jump.kind === 'break') assert(caption.includes('2'), caption);
            }
            assert.equal(await client.evaluate('window.edits.length'), 0); assert.deepEqual(client.errors, []);
        });
    });
});

test('a sole scoped block keeps its append control distinct from the file append control', { timeout: 60000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'do^{finally^:cleanup()}');
        await browser({ ...routes, '/':{type:'text/html',body:html(host.tree,false)} }, async client => {
            const ui = await graphUi(host, client);
            await graphToolbar(client, 'Unfold All');
            await ui.add('let', host.tree.root.fields.items[0]);
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('do^{let^value=0 finally^:cleanup()}')), host.tree.source);
            await ui.add('let');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('do^{let^value=0 finally^:cleanup()} let^value2=0')), host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('block bodies and handlers remain editable after clearing and rebuilding their statements', { timeout: 120000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('do^{\n# inner note\nlet^value=17 print(value) catch^error^:print(19) finally^:print(23)}'));
        const rebuilt = normalizedAst(await parse('do^{\n# inner note\nprint(29) catch^error^:print(31) finally^:print(37)}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/':{type:'text/html',body:html(host.tree,false)} }, async client => {
            const ui = await graphUi(host, client), block = () => host.tree.root.fields.items[0];
            const caught = () => block().fields.arms[0].fields.body, final = () => block().fields.extra[0];
            const argument = statement => statement.fields.value.fields.argument[0];
            const number = async (statement, text) => { await ui.expression(argument(statement), 'number');
                const owner = statement.start;
                const flat = n => [n,...Object.values(n.fields ?? {}).flat().flatMap(flat)];
                const updated = flat(host.tree.root).find(n => n.kind === 'call-stmt' && n.start === owner);
                await ui.input(`.box[data-source-start="${argument(updated).start}"] .literal-input`, text); };
            await ui.add('block'); await graphToolbar(client, 'Unfold All');
            await ui.add('comment', block()); await ui.input('.comment-box textarea', 'inner note');
            await ui.add('let', block());
            await ui.input(`.box[data-source-start="${block().fields.items[0].fields.values[0].start}"] .literal-input`, '17');
            await ui.add('call', block()); await ui.expression(argument(block().fields.items[1]), 'reference:value');
            await ui.structure(block(), 'catch:add'); await ui.add('call', caught()); await number(caught().fields.items[0], '19');
            await ui.structure(block(), 'finally:add'); await ui.add('call', final()); await number(final().fields.body[0], '23');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.remove(block().fields.items[0]); await ui.remove(block().fields.items[0]);
            assert.equal(block().fields?.items?.length ?? 0, 0);
            await ui.add('call', block()); await number(block().fields.items[0], '29');
            await ui.remove(caught().fields.items[0]); await ui.add('call', caught()); await number(caught().fields.items[0], '31');
            await ui.remove(final().fields.body[0]); await ui.add('call', final()); await number(final().fields.body[0], '37');
            assert.deepEqual(normalizedAst(host.tree), rebuilt, host.tree.source);
            await ui.remove(block().fields.arms[0]); await ui.remove(final());
            assert(!block().fields?.arms?.length && !block().fields?.extra?.length);
            await ui.remove(block().fields.items[0]); await ui.add('let', block()); await ui.remove(block().fields.items[0]);
            await ui.remove(block()); assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('block scopes preserve comments handler filters cleanup and local contents in semantic views', { timeout: 90000 }, async () => {
    const source = 'errordef^Issue{Bad,Other} do^{# inner note\nlet^mainValue=17 print(mainValue) catch^Issue.Bad|Issue.Other:print(19) catch^:print(23) finally^:print(29)} after(31)';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), block = tree.root.fields.items[1];
        await browser({ ...routes, '/':{type:'text/html',body:html(tree,false)} }, async client => {
            assert((await svgTexts(client)).join('').includes('Issue'));
            const check = async (inside = false) => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const number of ['17','19','23','29']) assert.equal(texts.filter(t => t === number).length, 1, text);
                for (const value of ['inner note','mainValue','Issue.Bad','Issue.Other',ja.Catch,ja.Finally]) assert(text.includes(value), value + ': ' + text);
                if (inside) { assert(!texts.includes('31')); assert(!text.includes(ja['Error definition'])); }
                else { assert.equal(texts.filter(t => t === '31').length, 1); assert(text.includes('after')); }
            };
            await graphToolbar(client, 'Unfold All'); await check(); await saveSemanticSvg(client, 'block-handlers');
            await graphToolbar(client, 'Fold All');
            assert((await svgTexts(client)).join('').includes('Issue'));
            await drillGraphNode(client, block); await graphToolbar(client, 'Unfold All'); await check(true);
            assert.equal(await client.evaluate('window.edits.length'), 0); assert.deepEqual(client.errors, []);
        });
    });
});

test('filtered and catch-all handlers with finally are constructed, edited and deleted through live graph controls', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        const expected = normalizedAst(await parse('do^{print(nil^) catch^Problem.First|Problem.Second:print(nil^) catch^: finally^:print(nil^)}'));
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), block = () => host.tree.root.fields.items[0];
            await ui.add('block');
            await ui.add('call', block());
            await ui.structure(block(), 'catch:all');
            await ui.structure(block(), 'catch:add');
            await ui.structure(block().fields.arms[0], 'catch:filter:Problem.First|Problem.Second');
            await ui.structure(block(), 'finally:add');
            await ui.add('call', block().fields.arms[0].fields.body);
            await ui.add('call', block().fields.extra[0]);
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            const filter = await client.evaluate(`[...document.querySelectorAll('.fold-summary')].map(e=>e.textContent)`);
            assert(filter.some(text => text.includes('Problem.First|Problem.Second')), filter.join(' / '));
            await client.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
            const screenshot = await client.call('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(require('node:os').tmpdir(), 'lhat-handler-edit.png'), Buffer.from(screenshot.data, 'base64'));

            await ui.remove(block().fields.arms[1]);
            assert.equal(block().fields.arms.length, 1);
            assert(host.tree.source.includes('finally^:'));
            await ui.structure(block().fields.arms[0], 'catch:unfiltered');
            assert(!block().fields.arms[0].fields.condition);
            await ui.remove(block().fields.arms[0]);
            assert.equal(block().fields.arms?.length ?? 0, 0);
            await ui.remove(block().fields.extra[0]);
            assert(!host.tree.source.includes('catch^') && !host.tree.source.includes('finally^'));
            assert.deepEqual(client.errors, []);
        });
    });
});

test('qualified type names remain complete editable annotations through the live type menu', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        const expected = normalizedAst(await parse('let^function=f^value:string^{return^0}'));
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), fn = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('function');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.addElement('parameter', fn(), 'params');
            const name = () => fn().fields.params[0].fields.name, type = () => fn().fields.params[0].fields.type;
            for (const reference of ['godot.Node2D','Self^^','日本語.型']) {
                await ui.typeStructure(name(), `type:reference:${reference}`);
                assert.equal(host.tree.source.slice(type().start, type().end), reference);
                const title = await client.evaluate(`document.querySelector('.type-label[data-type-start="${name().start}"]').title`);
                assert(title.includes(reference === "Self^^" ? "自身の型" : reference), title);
            }
            await ui.typeStructure(name(), 'type:name:string^');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('unnamed callable type inputs show one type caption and preserve the variadic marker', { timeout: 60000 }, async () => {
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse('let^Signature=(f^number^,string^,...:bool^ ->string^;)');
        assert.equal(tree.root.fields.items[0].fields.values[0].kind, 'type');
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree, false) } }, async client => {
            const check = async (editable = true) => {
                const texts = await svgTexts(client);
                assert.equal(texts.filter(t => t === ja.Number).length, 1, JSON.stringify(texts));
                assert.equal(texts.filter(t => t === ja.Text).length, 2, JSON.stringify(texts));
                assert.equal(texts.filter(t => t === ja.Boolean).length, 1, JSON.stringify(texts));
                if (!editable) return;
                const parameters = tree.root.fields.items[0].fields.values[0].fields.value.fields.params.map(p => ({ start:p.start, end:p.end }));
                const inputs = await client.evaluate(`${JSON.stringify(parameters)}.map(p=>{const e=document.querySelector('.box[data-source-start="'+p.start+'"][data-source-end="'+p.end+'"] .typed-name');return {type:e?.querySelector('.type-label')?.textContent,name:e?.querySelector(':scope>span')?.textContent}})`);
                assert.deepEqual(inputs, [{type:ja.Number,name:''},{type:ja.Text,name:''},{type:ja.Boolean,name:'...'}]);
            };
            await check(); await saveSemanticSvg(client, 'unnamed-parameters');
            await graphToolbar(client, 'Fold All'); await check(false); await graphToolbar(client, 'Unfold All'); await check();
            assert.equal(await client.evaluate('window.edits.length'), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('all annotation type forms retain full details and structure menus across semantic views', { timeout: 90000 }, async () => {
    const source = 'let^inspect=f^plain:number^,callback:(f^number^ -> string^;),stream:c^{p^* ->string^ ->-},descriptor:type^<number^>,table:t^{field:number^,string^[2],[string^]:bool^,self^{tag:string^}},tuple:(number^,string^),choice:(number^|nil^),both:(t^{}&t^{field:number^}) ->(number^,string^){return^17,"answer"}';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), fn = tree.root.fields.items[0].fields.values[0];
        const flat = n => [n,...Object.values(n.fields ?? {}).flat().flatMap(flat)];
        assert(!flat(tree.root).some(n => n.kind === 'error'), source);
        assert.deepEqual([...new Set(flat(tree.root).map(n => n.kind).filter(k => k.startsWith('type-') || k === 'member-decl'))].sort(),
            ['type-name','type-func','type-coro','type-apply','type-table','member-decl','type-tuple','type-union','type-intersect'].sort());
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree, false) } }, async client => {
            const details = [
                [ja.Number], [ja.Function,ja.Number,ja.Text], [ja['Coroutine type'],ja.Procedure,'*',ja.Text,'->','-'],
                ['type^<',ja.Number], ['field','tag','[2]',ja.Text,ja.Boolean,ja.Self],
                [ja.Number,ja.Text], [ja.Number,'|',ja['No value']], ['{}','&','{field:',ja.Number],
            ];
            const selector = parameter => `.type-label[data-type-start="${parameter.fields.name.start}"][data-type-end="${parameter.fields.name.end}"]`;
            const check = async () => {
                const texts = await svgTexts(client);
                assert(texts.includes(ja.Input)); assert(texts.includes(ja.Output));
                for (const [index, parameter] of fn.fields.params.entries()) {
                    const name = source.slice(parameter.fields.name.start, parameter.fields.name.end);
                    assert.equal(texts.filter(t => t === name).length, 1, JSON.stringify(texts));
                    const field = await client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector(parameter))});return e&&{label:e.textContent,title:e.title}})()`);
                    assert(field, name);
                    for (const detail of details[index]) assert(field.title.includes(detail), name + ': ' + JSON.stringify(field));
                    if (name === 'callback') assert.equal(field.label, ja.Function + '…');
                    if (name === 'table' || name === 'both') assert.equal(field.label, ja['Table type'] + '…');
                }
                for (const [index, item] of fn.fields.return_type.fields.items.entries()) assert(await client.evaluate(`!!document.querySelector('.type-label[data-type-start="${item.start}"][data-result-index="${index}"]')`));
            };
            await check(); await graphToolbar(client, 'Unfold All'); await check();
            const expanded = await svgTexts(client);
            assert.equal(expanded.filter(t => t === '17').length, 1); assert(expanded.join('').includes('answer'));
            await saveSemanticSvg(client, 'annotation-types');
            await graphToolbar(client, 'Fold All'); await check();
            await drillGraphNode(client, fn); await graphToolbar(client, 'Unfold All'); await check();
            for (const parameter of fn.fields.params) {
                await client.evaluate(`document.querySelector(${JSON.stringify(selector(parameter))}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
                await client.until(`document.querySelectorAll('.statement-menu [role=option]').length>6`);
                if (source.slice(parameter.fields.name.start, parameter.fields.name.end) === 'table') {
                    const menu = await client.evaluate(`document.querySelector('.statement-menu').textContent`);
                    for (const detail of ['field','tag','[2]']) assert(menu.includes(detail), menu);
                }
                await client.call('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
                await client.until(`!document.querySelector('.statement-menu')`);
            }
            assert.equal(await client.evaluate('window.edits.length'), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('typed instance positions and indexers are constructed, changed and removed through live type menus', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst, load } = require('./graph-browser-host.cjs');
    const structure = load('graphStructure.ts');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^function=f^value:t^{self^{number^[3],[string^]:any^}}{return^0}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), fn = () => host.tree.root.fields.items[0].fields.values[0];
            const name = () => fn().fields.params[0].fields.name, type = () => fn().fields.params[0].fields.type;
            const inner = () => type().fields.items[0].fields.value;
            const edit = async (suffix, value = '') => {
                const choice = structure.structureTemplates(host.tree, type()).find(c => c.id.startsWith('type:part:') && c.id.endsWith(suffix));
                assert(choice, suffix); await ui.typeStructure(name(), choice.id + value);
            };
            await ui.add('function');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.addElement('parameter', fn(), 'params');
            await ui.typeStructure(name(), 'type:name:t^{}');
            await ui.typeStructure(name(), 'type:append:items:typeSelf');
            await edit('type:append:items:number');
            await edit('type:position:0:count', ':3');
            await edit('type:append:items:typeIndexer');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await edit('type:position:0:tail');
            assert.match(host.tree.source, /number\^\[\]/);
            await edit('type:remove:items:1');
            await edit('type:remove:items:0');
            assert.equal(inner().fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('positional counts, type indexers and instance fields are built from the live type menu', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst, load } = require('./graph-browser-host.cjs'), structures = load('graphStructure.ts');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^function=f^value:t^{number^[3],[string^]:any^,self^{field:number^}}{return^0}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), fn = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('function');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.addElement('parameter', fn(), 'params');
            const name = () => fn().fields.params[0].fields.name, type = () => fn().fields.params[0].fields.type;
            await ui.typeStructure(name(), 'type:name:t^{}');
            await ui.typeStructure(name(), 'type:append:items:number');
            await ui.typeStructure(name(), 'type:position:0:count:3');
            await ui.typeStructure(name(), 'type:append:items:typeIndexer');
            await ui.typeStructure(name(), 'type:append:items:typeSelf');
            const append = structures.structureTemplates(host.tree, type()).find(c => c.id.startsWith('type:part:') && c.id.endsWith('type:append:items'));
            await ui.typeStructure(name(), append.id);
            const rename = structures.structureTemplates(host.tree, type()).find(c => c.id.startsWith('type:part:') && c.id.includes('type:rename:0'));
            await ui.typeStructure(name(), `${rename.id}:field`);
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.typeStructure(name(), 'type:position:0:tail');
            assert(host.tree.source.includes('number^[]'));
            await ui.typeStructure(name(), 'type:position:0:single');
            assert(!host.tree.source.includes('number^['));
            await ui.typeStructure(name(), 'type:remove:items:1');
            assert.equal(type().fields.items.length, 2);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('local expressions create anonymous focus values, name them and remove their names through live menus', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^value=(for^1 do^:it^;)'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), binding = () => host.tree.root.fields.items[0];
            const value = () => binding().fields.values[0], focus = () => value().fields.focus[0];
            await ui.add('let');
            await ui.expression(value(), 'local');
            await ui.input(`.box[data-source-start="${focus().fields.values[0].start}"] .literal-input`, '1');
            await ui.expression(value().fields.body, 'reference:it^');
            await ui.structure(value(), 'focus:value');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.equal(focus().fields.targets[0].kind, 'focus (it^)');
            assert.equal(await client.evaluate(`document.querySelector('.name-input[data-reference-start="${focus().fields.targets[0].start}"]')`), null);
            await ui.addElement('number', value(), 'focus');
            assert.equal(value().fields.focus.length, 2);
            await ui.remove(value().fields.focus[1]);
            assert.equal(focus().fields.targets[0].kind, 'focus (it^)');
            await ui.structure(value(), 'focus:bind');
            await ui.input(`.name-input[data-reference-start="${focus().fields.targets[0].start}"]`, '🧭');
            await ui.input(`.box[data-source-start="${focus().fields.values[0].start}"] .literal-input`, '2');
            await ui.type(focus().fields.targets[0], 'number^');
            await ui.structure(value(), 'focus:value');
            assert.equal(focus().fields.values[0].kind, 'param');
            await ui.structure(value(), 'focus:bind');
            assert.equal(focus().fields.targets[0].kind, 'param');
            await ui.input(`.box[data-source-start="${focus().fields.values[0].start}"] .literal-input`, '3');
            await ui.structure(value(), 'focus:value');
            assert.equal(focus().fields.targets[0].kind, 'focus (it^)');
            assert.equal(focus().fields.values[0].fields.name.kind, 'int');
            assert.equal(host.tree.source.slice(focus().fields.values[0].fields.name.start, focus().fields.values[0].fields.name.end), '3');
            await ui.structure(value(), 'focus:wrap');
            await ui.structure(value(), 'focus:unwrap');
            await ui.expression(value(), 'nil');
            await ui.remove(binding());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('Unicode declaration names, scope references and focused bindings edit through live graph controls', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), declaration = () => host.tree.root.fields.items[0];
            const binding = () => host.tree.root.fields.items[1], value = () => binding().fields.values[0];
            const rename = async (node, text) => ui.input(`.name-input[data-reference-start="${node.start}"]`, text);
            await ui.add('let');
            await rename(declaration().fields.targets[0], 'e\u0301');
            await ui.input('.literal-input', '1');
            await ui.add('let');
            await ui.expression(value(), 'reference:e\u0301');
            await rename(declaration().fields.targets[0], '🚀');
            assert.equal(host.tree.source.slice(value().start,value().end), '🚀');
            await ui.expression(value(), 'scope:file');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('let^🚀=1 let^value=$🚀')));
            await ui.structure(value(), 'scope:outer');
            await ui.structure(value(), 'scope:more');
            assert.equal(host.tree.source.slice(value().start,value().end), '$^^🚀');
            await ui.expression(value(), 'name');
            await ui.input(`.box[data-source-start="${value().start}"] .interpolation-input`, '👩‍💻');
            assert.equal(host.tree.source.slice(value().start,value().end), 'id^👩‍💻');
            await ui.expression(value(), 'local');
            const focus = () => value().fields.focus[0].fields.targets[0];
            await rename(focus(), 'e\u0301');
            await ui.expression(value().fields.body, 'reference:e\u0301');
            await rename(focus(), '👩‍💻');
            assert.equal(host.tree.source.slice(value().fields.body.start,value().fields.body.end), '👩‍💻');
            await ui.expression(value().fields.body, 'reference:it^');
            await ui.structure(value(), 'focus:wrap');
            await ui.expression(value().fields.body.fields.body, 'reference:it^^');
            await ui.structure(value(), 'focus:unwrap');
            await ui.expression(value(), 'nil');
            await ui.remove(binding());
            await ui.remove(declaration());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('names and focus captions preserve identity across folded and drilled semantic views', { timeout: 90000 }, async () => {
    const source = 'let^🚀=7 let^values={🚀,$🚀,id^`quoted name`,for^let^outer=1 for^let^inner=2 do^:(it^+it^^);,for^1 do^:it^;}';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), table = tree.root.fields.items[1].fields.values[0];
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree, false) } }, async client => {
            const { evaluate, until, call } = client, ready = `!document.querySelector('.svg-export>button').disabled`;
            const normal = await svgTexts(client);
            assert(normal.includes('🚀')); assert(normal.includes('values'));
            await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            const check = async () => {
                const labels = await svgTexts(client), text = labels.join('');
                for (const expected of ['$🚀','quoted name','outer','inner',ja['Current item'],ja['Outer {0}: {1}'].replace('{0}','1').replace('{1}',ja['Current item'])])
                    assert(text.includes(expected), expected + ': ' + text);
                assert.equal(labels.filter(text => text === '1').length, 2, 'generated focus nodes do not duplicate the two written values');
            };
            await check();
            await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Fold All')?.click()`);
            const folded = await svgTexts(client); assert(folded.includes('values')); assert(folded.includes(ja.Table));
            const selector = `.box.folded[data-source-start="${table.start}"][data-source-end="${table.end}"]`;
            await until(`document.querySelector(${JSON.stringify(selector)}) && ${ready}`);
            const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+8,y:r.top+8}})()`);
            for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent', { type, ...point, button:'left', clickCount:1 });
            await until(`document.querySelector('#trail') && ${ready}`);
            await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await check();
            assert.equal(await evaluate('window.edits.length'), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('contextual references and stacked focus names are selectable and retain their edited spelling', { timeout: 90000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), value = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('let');
            for (const reference of ['this^','this^^','it^^','def^','super^','L^','$^it^']) {
                await ui.expression(value(), `reference:${reference}`);
                assert.equal(host.tree.source.slice(value().start, value().end), reference);
            }
            await ui.expression(value(), 'nil');
            assert.equal(value().kind, 'hat-ident');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('callable templates and fresh results toggle through live controls and remain replaceable as complete expressions', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst, load } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^function=template^f^{return^0}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), fn = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('function');
            await ui.structure(fn(), 'function:template');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await client.until(`document.querySelector('[data-role="template"]')`);
            await ui.structure(fn(), 'function:template');
            await ui.structure(fn(), 'function:fresh');
            await client.until(`document.querySelector('[data-role="fresh"]')`);
            const site = load('graphTypes.ts').typeSites(host.tree).find(s => s.name === 'return value');
            await ui.type(site, undefined);
            assert(!host.tree.source.includes('fresh^'));
            await ui.structure(fn(), 'function:template');
            await ui.expression(fn(), 'nil');
            assert.equal(fn().kind, 'hat-ident');
            assert(!host.tree.source.includes('template^'));
            assert.deepEqual(client.errors, []);
        });
    });
});

test('mutable receivers and fresh promises are edited inside both callable bodies and annotated signatures', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, load } = require('./graph-browser-host.cjs'), structure = load('graphStructure.ts');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), items = () => host.tree.root.fields.items;
            await ui.add('tableDefinition');
            const def = () => items()[0].fields.values[0];
            await ui.addElement('member', def());
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.expression(def().fields.items[0].fields.value, 'function');
            const method = () => def().fields.items[0].fields.value;
            await ui.addElement('receiver', method(), 'params');
            await ui.structure(method().fields.params[0], 'receiver:mutable');
            assert(host.tree.source.includes('mutable^self^'));
            await ui.structure(method().fields.params[0], 'receiver:mutable');
            await ui.add('function');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            const fn = () => items()[1].fields.values[0];
            await ui.addElement('parameter', fn(), 'params');
            const name = () => fn().fields.params[0].fields.name, type = () => fn().fields.params[0].fields.type;
            await ui.typeStructure(name(), 'type:function');
            await ui.typeStructure(name(), 'type:append:receiver');
            await ui.typeStructure(name(), 'type:receiver:0:mutable');
            await ui.typeStructure(name(), 'function:fresh');
            assert(!structure.structureTemplates(host.tree, type()).some(c => c.id === 'type:append:return_type'));
            await ui.typeStructure(name(), 'function:fresh');
            await ui.typeStructure(name(), 'type:receiver:0:mutable');
            assert.equal(type().fields.params.length, 2);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('operator operands and complex access targets stay editable through construction and deletion', { timeout: 120000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = {};
        for (const [key, expression] of [['unary','bitnot^(17+23)'],['index','({29,31})[1]'],['call','(({29,31})[1]).tostring()']])
            expected[key] = normalizedAst(await parse(`let^value=${expression}`));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), value = () => host.tree.root.fields.items[0].fields.values[0];
            const number = (node, text) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, text);
            await ui.add('let'); await ui.expression(value(), 'add');
            await number(value().fields.left, '17'); await number(value().fields.right, '19');
            await ui.expression(value(), 'negative');
            const operand = () => value().fields.operand ?? value().fields.value;
            await number(operand().fields.right, '23'); await ui.operator(value(), 'bitnot^');
            assert.deepEqual(normalizedAst(host.tree), expected.unary, host.tree.source);
            await ui.expression(value(), 'unwrap'); assert.equal(value().kind, 'binary');
            await ui.expression(value(), 'table'); await graphToolbar(client, 'Unfold All');
            for (const text of ['29','31']) {
                await ui.addElement('number', value()); await number(value().fields.items.at(-1), text);
            }
            await ui.expression(value(), 'index'); await number(value().fields.argument[0], '1');
            assert.deepEqual(normalizedAst(host.tree), expected.index, host.tree.source);
            await ui.structure(value(), 'access:nil-check'); await ui.structure(value(), 'access:nil-check');
            await ui.expression(value(), 'member');
            await ui.expression(value().fields.argument[0], 'reference:tostring');
            await ui.expression(value(), 'call');
            assert.deepEqual(normalizedAst(host.tree), expected.call, host.tree.source);
            await ui.structure(value(), 'access:nil-check'); await ui.structure(value(), 'access:nil-check');
            const receiver = () => value().fields.target.fields.target;
            await number(receiver().fields.argument[0], '0');
            assert.equal(receiver().fields.argument[0].kind, 'int');
            await ui.expression(value(), 'number'); await ui.remove(host.tree.root.fields.items[0]);
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('operators and access expressions retain operands and captions across semantic views', { timeout: 90000 }, async () => {
    const source = 'let^echo=f^x:number^{x} let^values={neg=-(17+19),sum=23+29,chain=31<37<41,member={key=43}.key,index={47,53}[1],called=echo(59),cast=61 as^number^}';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), table = tree.root.fields.items[1].fields.values[0];
        const flat = n => [n,...Object.values(n.fields ?? {}).flat().flatMap(flat)];
        assert(!flat(tree.root).some(n => n.kind === 'error'), source);
        for (const kind of ['unary','binary','compare-chain','member','index','call','as']) assert(flat(tree.root).some(n => n.kind === kind), kind);
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree, false) } }, async client => {
            const normal = (await svgTexts(client)).join(''); assert(normal.includes('values')); assert(normal.includes(ja.Table));
            const contents = async () => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const number of ['17','19','23','29','31','37','41','43','47','53','59','61','1'])
                    assert.equal(texts.filter(t => t === number).length, 1, number + ': ' + JSON.stringify(texts));
                for (const key of ['neg','sum','chain','member','index','called','cast','key','echo']) assert(text.includes(key), key + ': ' + text);
                assert.equal(texts.filter(t => t === '+').length, 2, JSON.stringify(texts));
                assert.equal(texts.filter(t => t === '<').length, 2, JSON.stringify(texts));
                assert(texts.includes('-'), JSON.stringify(texts));
                assert(text.includes(ja['As type']), text);
            };
            await graphToolbar(client, 'Unfold All'); await contents(); await saveSemanticSvg(client, 'operator-values');
            await graphToolbar(client, 'Fold All');
            const folded = (await svgTexts(client)).join(''); assert(folded.includes('values')); assert(folded.includes(ja.Table));
            assert(!folded.includes('called')); assert(!folded.includes('chain'));
            await drillGraphNode(client, table); await graphToolbar(client, 'Unfold All'); await contents();
            assert.equal(await client.evaluate('window.edits.length'), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('nil-checked member, index and call forms are constructed through live access controls', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = {};
        for (const [kind, expression] of [['member','obj?.value'], ['index','obj?[0]'], ['call','fn?(nil^)']])
            expected[kind] = normalizedAst(await parse(`let^value=${expression}`));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), value = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('let');
            for (const kind of ['member', 'index', 'call']) {
                await ui.expression(value(), `reference:${kind === 'call' ? 'fn' : 'obj'}`);
                await ui.expression(value(), kind);
                await ui.structure(value(), 'access:nil-check');
                assert.deepEqual(normalizedAst(host.tree), expected[kind], host.tree.source);
                const text = (await svgTexts(client)).join('');
                assert(text.includes(kind === 'member' ? '?.' : kind === 'index' ? '?[' : ja.Call + ' ?'), text);
                if (kind === 'call') await client.until(`[...document.querySelectorAll('.boxlabel')].some(e=>e.textContent===${JSON.stringify(ja.Call + ' ?')})`);
                await ui.structure(value(), 'access:nil-check');
                assert(!host.tree.source.includes('?.') && !host.tree.source.includes('?[') && !host.tree.source.includes('?('));
            }
            assert.deepEqual(client.errors, []);
        });
    });
});

test('comparison chains build and change their operands and operators through live graph controls', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^value=0<=4<0'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), value = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('let');
            await ui.expression(value(), 'chain');
            await ui.input(`.box[data-source-start="${value().fields.operands[1].start}"] .literal-input`, '4');
            await ui.operator(value(), '<=');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.operator(value(), '≦');
            assert(host.tree.source.includes('≦'));
            await ui.operator(value(), '<=');
            await ui.structure(value(), 'chain:append');
            assert.equal(value().fields.operands.length, 4);
            await ui.structure(value(), 'chain:remove-last');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.structure(value(), 'chain:remove-last');
            assert.equal(value().kind, 'binary');
            await ui.structure(value(), 'chain:append');
            assert.equal(value().kind, 'compare-chain');
            await ui.expression(value(), 'nil');
            assert.equal(value().kind, 'hat-ident');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('module values import and edit their path through the shared source input', { timeout: 60000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^value=import^std.math'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), value = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('let');
            await ui.expression(value(), 'import');
            await ui.input(`.box[data-source-start="${value().start}"] .interpolation-input`, 'std.math');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.expression(value(), 'nil');
            assert.equal(value().kind, 'hat-ident');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('coroutine kind, omitted slots and wildcard or endless results edit through the live type label', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^function=f^value:c^{p^* -> -> -}{return^0}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), fn = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('function');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.addElement('parameter', fn(), 'params');
            const name = () => fn().fields.params[0].fields.name, type = () => fn().fields.params[0].fields.type;
            await ui.typeStructure(name(), 'type:coroutine');
            await ui.typeStructure(name(), 'coroutine:kind:procedure');
            await ui.typeStructure(name(), 'coroutine:receive:any');
            await ui.typeStructure(name(), 'coroutine:produce:omit');
            await ui.typeStructure(name(), 'coroutine:result:endless');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.typeStructure(name(), 'coroutine:result:omit');
            assert.equal(type().fields, undefined);
            await ui.typeStructure(name(), 'coroutine:receive:type');
            await ui.typeStructure(name(), 'coroutine:produce:any');
            await ui.typeStructure(name(), 'coroutine:result:type');
            await ui.typeStructure(name(), 'coroutine:kind:either');
            assert.equal(type().fields.receive.kind, 'type-name');
            assert.equal(type().fields.result.kind, 'type-name');
            await ui.typeStructure(name(), 'coroutine:receive:omit');
            assert.equal(type().fields.receive, undefined);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('table member names and function type arities edit from the annotation menu through live source changes', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^function=f^value:t^{日本語:number^}{return^0}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), fn = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('function');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.addElement('parameter', fn(), 'params');
            const name = () => fn().fields.params[0].fields.name, type = () => fn().fields.params[0].fields.type;
            await ui.typeStructure(name(), 'type:name:t^{}');
            await ui.typeStructure(name(), 'type:append:items');
            await ui.typeStructure(name(), 'type:rename:0:日本語');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.typeStructure(name(), 'type:remove:items:0');
            await ui.typeStructure(name(), 'type:function');
            await ui.typeStructure(name(), 'type:append:params');
            assert.equal(type().fields.params.length, 2);
            await ui.typeStructure(name(), 'type:remove:params:0');
            await ui.typeStructure(name(), 'type:append:return_type');
            assert.equal(type().fields.return_type.kind, 'type-tuple');
            await ui.typeStructure(name(), 'type:remove:return_type:0');
            await ui.typeStructure(name(), 'type:remove:return_type:0');
            assert.equal(type().fields.return_type, undefined);
            await ui.typeStructure(name(), 'type:append:return_type');
            assert.equal(type().fields.return_type.kind, 'type-name');
            await ui.typeStructure(name(), 'function:kind:procedure');
            await ui.typeStructure(name(), 'type:append:variadic');
            assert.equal(type().fields.params.length, 2);
            await ui.typeStructure(name(), 'type:variadic:1:untyped');
            assert(!type().fields.params[1].fields?.type);
            await ui.typeStructure(name(), 'type:variadic:1:type');
            assert.equal(type().fields.params[1].fields.type.kind, 'type-name');
            await ui.typeStructure(name(), 'function:kind:function');
            await ui.typeStructure(name(), 'type:remove:params:1');
            assert.equal(type().fields.params.length, 1);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('nested tuple, applied and coroutine types are constructed from a parameter type label through live menus', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, load } = require('./graph-browser-host.cjs'), structure = load('graphStructure.ts');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), fn = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('function');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.addElement('parameter', fn(), 'params');
            const name = () => fn().fields.params[0].fields.name, type = () => fn().fields.params[0].fields.type;
            await ui.typeStructure(name(), 'type:tuple');
            assert.equal(type().kind, 'type-tuple');
            await ui.typeStructure(name(), 'type:part:2:type:name:string^');
            assert(host.tree.source.includes('string^'));
            await ui.typeStructure(name(), 'type:append');
            assert.equal(type().fields.items.length, 3);
            await ui.typeStructure(name(), 'type:remove:0');
            assert.equal(type().fields.items.length, 2);
            await ui.typeStructure(name(), 'type:apply');
            assert.equal(type().kind, 'type-apply');
            await ui.typeStructure(name(), 'type:coroutine');
            assert.equal(type().kind, 'type-coro');
            const variant = structure.structureTemplates(host.tree, type()).find(c => c.id.startsWith('type:part:') && c.id.endsWith('type:name:bool^'));
            assert(variant);
            await ui.typeStructure(name(), variant.id);
            assert(host.tree.source.includes('bool^'));
            await ui.typeStructure(name(), 'type:name:number^');
            assert.equal(type().kind, 'type-name');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('delegated members are created, retargeted and removed through the live definition controls', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^Item=def^{base=0,delegate^base}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), def = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('tableDefinition');
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.addElement('member', def());
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await client.until(`!document.querySelector('.svg-export>button').disabled`);
            await ui.input(`.name-input[data-reference-start="${def().fields.items[0].fields.key.start}"]`, 'base');
            await ui.addElement('delegate', def());
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            const entry = () => def().fields.items[1];
            await ui.expression(entry().fields.value, 'reference:self^.base');
            assert.equal(entry().fields.value.kind, 'member');
            await client.until(`[...document.querySelectorAll('.boxlabel')].some(e=>e.textContent.includes('委譲'))`);
            await ui.expression(entry().fields.value, 'reference:base');
            await ui.remove(entry());
            assert.equal(def().fields.items.length, 1);
            await ui.addElement('delegate', def());
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('written type descriptors keep nil and tuple types through live structure menus', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, load } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server), structure = load('graphStructure.ts');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), value = () => host.tree.root.fields.items[0].fields.values[0];
            const type = () => value().fields.value;
            await ui.add('let');
            await ui.expression(value(), 'typeValue');
            for (const [action, expected] of [
                ['type:nullable', 'type^<number^|nil^>'],
                ['type:intersection', undefined],
                ['type:name:number^', 'type^<number^>'],
                ['type:tuple', 'type^<(number^, any^)>'],
            ]) {
                await ui.structure(type(), action);
                assert.equal(value().kind, 'type', host.tree.source);
                if (expected) assert.equal(value().inferredType, expected);
            }
            const part = structure.structureTemplates(host.tree, type()).find(c => c.id.startsWith('type:part:') && c.id.endsWith('type:name:string^') && c.text.includes('number^, string^'));
            assert(part, host.tree.source);
            await ui.structure(type(), part.id);
            assert.equal(value().inferredType, 'type^<(number^, string^)>');
            await ui.structure(type(), 'type:keep:right');
            assert.equal(value().kind, 'type');
            assert.equal(value().inferredType, 'type^<(number^, string^)>');
            await ui.structure(type(), 'type:reference:nil^');
            assert.equal(value().kind, 'type');
            assert.equal(value().inferredType, 'type^<nil^>');
            assert(!structure.structureTemplates(host.tree, type()).some(c => c.id === 'type:name:value'));
            await ui.structure(type(), 'type:name:string^');
            assert.equal(value().inferredType, 'type^<string^>');
            await ui.expression(value(), 'number');
            assert.equal(value().kind, 'int');
            await ui.remove(host.tree.root.fields.items[0]);
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('type queries, boxes and type values are created and edited through their shared graph controls', { timeout: 90000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), value = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('let');
            await ui.expression(value(), 'typeof');
            assert.equal(value().kind, 'typeof');
            await ui.input(`.box[data-source-start="${value().fields.value.start}"] .literal-input`, '7');
            await ui.expression(value(), 'unwrap');
            assert.equal(host.tree.source.slice(value().start, value().end), '7');
            await ui.expression(value(), 'box');
            await ui.structure(value(), 'box:toggle');
            assert(host.tree.source.includes('constbox^'));
            await ui.expression(value().fields.value, 'string');
            await ui.expression(value(), 'unwrap');
            assert.equal(value().kind, 'string');
            await ui.expression(value(), 'typeValue');
            await ui.structure(value().fields.value, 'type:name:string^');
            assert.equal(value().kind, 'type');
            await ui.expression(value(), 'nil');
            assert.equal(value().kind, 'hat-ident');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('name values and explicit scope distances edit through live graph inputs without renaming declarations', { timeout: 90000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), value = () => host.tree.root.fields.items[1].fields.values[0];
            await ui.add('let');
            await ui.add('let');
            await ui.expression(value(), 'reference:value');
            await ui.expression(value(), 'scope:file');
            await ui.structure(value(), 'scope:more');
            assert.equal(host.tree.source.slice(value().start, value().end), '$$value');
            await ui.structure(value(), 'scope:less');
            await ui.structure(value(), 'scope:outer');
            await ui.structure(value(), 'scope:more');
            assert.equal(host.tree.source.slice(value().start, value().end), '$^^value');
            await ui.expression(value(), 'reference:$value');
            assert.equal(value().kind, 'scope');
            await ui.expression(value(), 'name');
            await ui.input(`.box[data-source-start="${value().start}"] .interpolation-input`, '日本語^');
            assert.equal(host.tree.source.slice(value().start, value().end), 'id^日本語^');
            assert.equal(host.tree.source.slice(host.tree.root.fields.items[0].fields.targets[0].start, host.tree.root.fields.items[0].fields.targets[0].end), 'value');
            await ui.expression(value(), 'nil');
            assert.equal(value().kind, 'hat-ident');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('trailing tuple arguments expand and unwrap through the live UI while retaining inner element editors', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('print((4,0)...)'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), call = () => host.tree.root.fields.items[0].fields.value;
            const arg = () => call().fields.argument[0];
            await ui.add('call');
            await ui.expression(arg(), 'tuple');
            await ui.expression(arg(), 'spread');
            assert.equal(arg().kind, 'spread');
            await ui.input(`.box[data-source-start="${arg().fields.value.fields.items[0].start}"] .literal-input`, '4');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.expression(arg(), 'unwrap');
            assert.equal(arg().kind, 'tuple');
            await ui.addElement('default', call(), 'argument');
            assert.equal(call().fields.argument.length, 2);
            await ui.expression(call().fields.argument[1], 'tuple');
            await ui.expression(call().fields.argument[1], 'spread');
            await ui.remove(call().fields.argument[1]);
            assert.equal(call().fields.argument.length, 1);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('local expressions are built and nested through focus controls while retaining editable bindings and results', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^value=(for^let^amount=2 do^:(amount+3);)'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), value = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('let');
            await ui.expression(value(), 'local');
            const focus = () => value().fields.focus[0];
            await ui.input(`.name-input[data-reference-start="${focus().fields.targets[0].start}"]`, 'amount');
            await ui.input(`.box[data-source-start="${focus().fields.values[0].start}"] .literal-input`, '2');
            await ui.expression(value().fields.body, 'reference:amount');
            await ui.expression(value().fields.body, 'add');
            await ui.input(`.box[data-source-start="${value().fields.body.fields.right.start}"] .literal-input`, '3');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.structure(value(), 'focus:wrap');
            assert.equal(value().fields.body.kind, 'for');
            await ui.structure(value().fields.body, 'focus:wrap');
            assert.equal(value().fields.body.fields.body.kind, 'for');
            await ui.structure(value(), 'focus:unwrap');
            await ui.structure(value(), 'focus:unwrap');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.expression(value(), 'nil');
            assert.equal(value().kind, 'hat-ident');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('a shared for driver is constructed through outer focus controls and stays editable after scope removal', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('for^let^limit=0 for^i from^1 downto^limit {print(nil^)}'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), loop = () => host.tree.root.fields.items[0];
            await ui.add('for');
            await ui.structure(loop(), 'focus:wrap');
            const name = loop().fields.focus[0].fields.targets[0];
            await ui.input(`.name-input[data-reference-start="${name.start}"]`, 'limit');
            await ui.expression(loop().fields.body.fields.bound, 'reference:limit');
            await ui.structure(loop().fields.body, 'direction');
            assert(host.tree.source.includes('downto^'));
            await ui.add('call', loop().fields.body.fields.body);
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.expression(loop().fields.body.fields.bound, 'number');
            await ui.structure(loop(), 'focus:unwrap');
            assert.equal(loop().fields.body.kind, 'block');
            assert.equal(loop().fields.body.fields.items.length, 1);
            await ui.remove(loop());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('type tests and casts use editable type operands and preserve values across operator changes', { timeout: 60000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), value = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('let');
            await ui.expression(value(), 'fits');
            const annotation = () => value().fields.type ?? value().fields.right;
            await ui.structure(annotation(), 'type:name:string^');
            await ui.expression(value().fields.left, 'string');
            await ui.operator(value(), 'as^');
            assert.equal(value().kind, 'as');
            assert.equal(value().fields.value.kind, 'string');
            await ui.structure(annotation(), 'type:nullable');
            assert.equal(annotation().kind, 'type-union');
            await ui.operator(value(), 'fits^');
            assert.equal(value().kind, 'binary');
            assert.equal(annotation().kind, 'type-union');
            await ui.expression(value(), 'cast');
            assert.equal(value().kind, 'as');
            await ui.expression(value(), 'nil');
            assert.equal(value().kind, 'hat-ident');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('postfix nil checks are created, displayed and edited through the live source', { timeout: 60000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), value = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.add('let');
            await ui.expression(value(), 'present');
            assert.equal(value().kind, 'unary');
            const visibleCheck = () => `document.querySelector('.box[data-source-start="${value().end - 1}"] .boxlabel')?.textContent==='?'`;
            await client.until(visibleCheck());
            await ui.expression(value().fields.operand, 'string');
            const operand = value().fields.operand;
            await ui.input(`.box[data-source-start="${operand.start}"] .literal-input`, 'available');
            assert(host.tree.source.includes('"available")?'));
            await client.until(visibleCheck());
            await ui.expression(value(), 'unwrap');
            assert.equal(value().kind, 'string');
            assert(host.tree.source.includes('"available"'));
            await ui.expression(value(), 'nil');
            assert.equal(value().kind, 'hat-ident');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('custom statement context disables and restores a UI-created enum through the real server', { timeout: 60000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client);
            await ui.add('enumeration');
            const original = normalizedAst(host.tree);
            await ui.toggleStatement(host.tree.root.fields.items[0]);
            assert.equal(host.tree.root.fields.items[0].kind, 'disabled');
            await ui.toggleStatement(host.tree.root.fields.items[0]);
            assert.deepEqual(normalizedAst(host.tree), original);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('edit controls remain separate from each other and literal inputs during real pointer interaction', { timeout: 60000 }, async () => {
    const { graphHost } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'let^mapping={[0]=10}');
        const entry = host.tree.root.fields.items[0].fields.values[0].fields.items[0], key = entry.fields.key;
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            await client.until(`document.querySelector('.svg-export>button') && !document.querySelector('.svg-export>button').disabled`);
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            const selectors = [`.structure-edit[data-structure-start="${entry.start}"][data-structure-end="${entry.end}"]`,
                `.element-delete[data-delete-start="${entry.start}"][data-delete-end="${entry.end}"]`,
                `.expression-edit[data-expression-start="${key.start}"][data-expression-end="${key.end}"]`];
            await client.until(`document.querySelector(${JSON.stringify(selectors[2])}) && !document.querySelector('.svg-export>button').disabled`);
            const box = await client.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selectors[2])}).closest('.react-flow__node').querySelector('.box').getBoundingClientRect();return {x:r.left+4,y:r.top+4}})()`);
            await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box });
            const hit = selector => `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===e})()`;
            for (const selector of selectors) await client.until(hit(selector));
            assert.equal(await client.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selectors[2])}).closest('.react-flow__node').querySelector('.literal-input'),r=input.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===input})()`), true);
            const click = async selector => {
                const point = await client.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
                await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
                await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
                await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
            };
            for (const selector of [selectors[0], selectors[2]]) {
                await click(selector); await client.until(`document.querySelector('.statement-menu [role=option]')`);
                await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
                await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
                await client.until(`!document.querySelector('.statement-menu')`);
            }
            await click(selectors[1]); await client.until('window.edits.length===1');
            const message = await client.evaluate('window.edits[0]');
            assert.equal(message.type, 'deleteElement');
            assert.equal(message.site.start, entry.start);
            await host.edit(message);
            assert.equal(host.tree.root.fields.items[0].fields.values[0].fields?.items?.length ?? 0, 0);
            await client.evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(host.tree)},uri:'file:///svg-example.lh',version:${host.version}},'*')`);
            await client.until(`document.querySelector('#app')?.dataset.graphVersion==='${host.version}' && !document.querySelector('.svg-export>button').disabled`);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('call-result bindings can be discarded and named again without shifting later results', { timeout: 60000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'let^pair=f^{(10,"two",30)}\nlet^first,second,third=pair()');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), binding = () => host.tree.root.fields.items[1];
            await ui.remove(binding().fields.targets[1]);
            assert.equal(host.tree.source.slice(binding().fields.targets[1].start, binding().fields.targets[1].end), '_^');
            await ui.input(`.name-input[data-reference-start="${binding().fields.targets[1].start}"]`, 'middle');
            await ui.remove(binding().fields.targets[0]);
            const expected = await parse('let^pair=f^{(10,"two",30)}\nlet^_^,middle,third=pair()');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(expected));
            assert.equal(binding().fields.targets[2].inferredType, 'number^');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('mixed tables and tuples are created, reduced and readded through live list controls', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const expected = normalizedAst(await parse('let^data={named=17,[23]=29,(31,37),nested={leaf=41}} let^pair=(43,"対",{code=47})'));
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), items = () => host.tree.root.fields.items;
            const data = () => items()[0].fields.values[0], pair = () => items()[1].fields.values[0];
            const unfold = async () => {
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await client.until(`!document.querySelector('.svg-export>button').disabled`);
            };
            const rename = async (node, name) => ui.input(`.name-input[data-reference-start="${node.start}"]`, name);
            const literal = async (node, text) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, text);
            await ui.add('let'); await rename(items()[0].fields.targets[0], 'data');
            await ui.expression(data(), 'table'); await unfold();
            await ui.addElement('member', data());
            await rename(data().fields.items[0].fields.key, 'named');
            await literal(data().fields.items[0].fields.value, '17');
            await ui.addElement('member', data());
            await ui.structure(data().fields.items[1], 'key:number');
            await literal(data().fields.items[1], '23');
            await literal(data().fields.items[1].fields.value, '29');
            await ui.addElement('number', data());
            await ui.expression(data().fields.items[2].fields.value, 'tuple'); await unfold();
            for (const [index, value] of ['31','37'].entries()) await literal(data().fields.items[2].fields.value.fields.items[index], value);
            await ui.addElement('member', data());
            await rename(data().fields.items[3].fields.key, 'nested');
            await ui.expression(data().fields.items[3].fields.value, 'table'); await unfold();
            await ui.addElement('member', data().fields.items[3].fields.value);
            const leaf = () => data().fields.items[3].fields.value.fields.items[0];
            await rename(leaf().fields.key, 'leaf'); await literal(leaf().fields.value, '41');
            await ui.add('let'); await rename(items()[1].fields.targets[0], 'pair');
            await ui.expression(pair(), 'tuple'); await unfold();
            await literal(pair().fields.items[0], '43');
            await ui.expression(pair().fields.items[1], 'string'); await literal(pair().fields.items[1], '対');
            await ui.addElement('table', pair()); await unfold();
            await ui.addElement('member', pair().fields.items[2]);
            const code = () => pair().fields.items[2].fields.items[0];
            await rename(code().fields.key, 'code'); await literal(code().fields.value, '47');
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            await ui.remove(pair().fields.items[2]); await ui.remove(pair().fields.items[1]);
            assert.equal(pair().kind, 'int'); assert.equal(host.tree.source.slice(pair().start,pair().end), '43');
            await literal(pair(), '53');
            await ui.expression(pair(), 'tuple'); await unfold();
            for (let index = 3; index >= 0; index--) await ui.remove(data().fields.items[index]);
            assert.equal(data().fields?.items?.length ?? 0, 0);
            await ui.addElement('number', data()); await literal(data().fields.items[0].fields.value, '59');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('let^data={59} let^pair=(0,0)')));
            await ui.remove(items()[1]); await ui.remove(items()[0]);
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('table keys and tuple members retain their values and boundaries across semantic views', { timeout: 90000 }, async () => {
    const source = 'let^data={named=17,["raw,key"]="文字列値",[23]=29,(31,37),nested={leaf=41}} let^pair=(43,"対",{code=47})';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), table = tree.root.fields.items[0].fields.values[0], tuple = tree.root.fields.items[1].fields.values[0];
        await browser({ ...routes, '/': { type: 'text/html', body: html(tree, false) } }, async client => {
            const { evaluate, until, call } = client, ready = `!document.querySelector('.svg-export>button').disabled`;
            const normal = await svgTexts(client); assert(normal.includes('data')); assert(normal.includes('pair'));
            assert.equal(normal.filter(text => text === ja.Table).length, 2, JSON.stringify(normal));
            assert(normal.includes('43') && normal.some(text => text.includes('対')), JSON.stringify(normal));
            const check = async (values, names) => {
                const texts = await svgTexts(client);
                for (const value of values) assert.equal(texts.filter(t => t === value).length, 1, value + ': ' + JSON.stringify(texts));
                for (const name of names) assert(texts.some(t => t.includes(name)), name + ': ' + JSON.stringify(texts));
            };
            const unfold = async () => {
                await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All').click()`);
                await until(ready);
            };
            const fold = async () => {
                await evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Fold All').click()`);
                await until(ready);
            };
            await unfold();
            await check(['17','23','29','31','37','41','43','47'], ['named','raw,key','文字列値','nested','leaf','対','code']);
            await fold();
            const folded = await svgTexts(client); assert(folded.includes('data')); assert(folded.includes('pair'));
            assert(folded.includes(ja.Table), JSON.stringify(folded));
            assert(folded.some(text => text.includes('(') && text.includes('…')), JSON.stringify(folded));
            for (const node of [table, tuple]) {
                const selector = `.box.folded[data-source-start="${node.start}"][data-source-end="${node.end}"]`;
                await until(`document.querySelector(${JSON.stringify(selector)}) && ${ready}`);
                const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+8,y:r.top+8}})()`);
                for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent', { type, ...point, button:'left', clickCount:1 });
                await until(`document.querySelector('#trail') && ${ready}`); await unfold();
                if (node === table) await check(['17','23','29','31','37','41'], ['named','raw,key','文字列値','nested','leaf']);
                else await check(['43','47'], ['対','code']);
                await evaluate(`document.querySelector('#trail button').click()`);
                await until(`!document.querySelector('#trail') && ${ready}`); await fold();
            }
            assert.equal(await evaluate('window.edits.length'), 0);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('computed table keys build references, arithmetic and calls while preserving values and ownership', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'let^base=4\nlet^make=f^x:number^{x}\nlet^mapping={name="hi",other=20}');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), table = () => host.tree.root.fields.items[2].fields.values[0], member = () => table().fields.items[0];
            await client.until(`document.querySelector('.svg-export>button') && !document.querySelector('.svg-export>button').disabled`);
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.structure(member(), 'key:number');
            await ui.expression(member().fields.key, 'reference:base');
            await ui.expression(member().fields.key, 'add');
            await ui.input(`.box[data-source-start="${member().fields.key.fields.right.start}"] .literal-input`, '1');
            assert.equal(member().fields.key.kind, 'binary');
            assert.equal(host.tree.source.slice(member().fields.value.start, member().fields.value.end), '"hi"');
            await ui.expression(member().fields.key, 'reference:make');
            await ui.expression(member().fields.key, 'call');
            await ui.expression(member().fields.key.fields.argument[0], 'reference:base');
            assert.equal(member().fields.key.kind, 'call');
            await ui.type(member().fields.key, 'string^');
            assert.equal(host.tree.source.slice(member().fields.type.start, member().fields.type.end), 'string^');
            await ui.type(member().fields.key, undefined);
            assert(!member().fields.type);
            await ui.structure(member(), 'key:string');
            await ui.input(`.box[data-source-start="${member().start}"] .literal-input`, 'field');
            await ui.structure(member(), 'key:identifier');
            const expected = await parse('let^base=4\nlet^make=f^x:number^{x}\nlet^mapping={field="hi",other=20}');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(expected));
            await ui.remove(member());
            assert.equal(table().fields.items.length, 1);
            assert.equal(host.tree.source.slice(table().fields.items[0].fields.key.start, table().fields.items[0].fields.key.end), 'other');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('every loop section can be added, edited and deleted through common UI controls', { timeout: 180000 }, async () => {
    const { graphHost, graphUi, load } = require('./graph-browser-host.cjs');
    const { structuralDeletions } = load('graphDelete.ts');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), loop = () => host.tree.root.fields.items.at(-1);
            for (const section of ['prolog^', 'pre^', 'first^', 'main^', 'last^', 'epilog^', 'finally^']) {
                await ui.add('repeat');
                await ui.structure(loop(), `section:${section}`);
                const body = () => loop().fields.body;
                const target = () => section === 'main^' ? body() : body().fields.extra.find(n => host.tree.source.slice(n.start, n.end).startsWith(section));
                await ui.add('call', target());
                assert.equal(section === 'main^' ? target().fields.items.length : target().fields.body.length, 1);
                const deletion = structuralDeletions(host.tree).find(entry => entry.owner.start === loop().start && entry.action === `remove-section:${section}`);
                assert(deletion, section);
                await ui.remove(deletion.site);
                assert.equal(body().fields?.items?.length ?? 0, 0);
                assert.equal(body().fields?.extra?.length ?? 0, 0);
            }
            assert.deepEqual(client.errors, []);
        });
    });
});

test('branch and loop-clause delete buttons update the source through common controls', { timeout: 60000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'if^true^{print(1) el^false^:print(2) el^:print(3)}\nrepeat^2{pre^:print(4) main^:print(5) epilog^:print(6)}');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), items = () => host.tree.root.fields.items;
            await client.until(`document.querySelector('.svg-export>button') && !document.querySelector('.svg-export>button').disabled`);
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await ui.remove(items()[0].fields.items[1]);
            await ui.remove(items()[1].fields.body.fields.extra[0]);
            const { structuralDeletions } = require('./graph-browser-host.cjs').load('graphDelete.ts');
            const main = structuralDeletions(host.tree).find(entry => entry.action === 'remove-section:main^');
            await ui.remove(main.site);
            await ui.add('call', items()[1].fields.body);
            const expected = await parse('if^true^{print(1) el^:print(3)}\nrepeat^2{main^:print(nil^) epilog^:print(6)}');
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(expected));
            assert.deepEqual(client.errors, []);
        });
    });
});

test('return type delete buttons remove one result annotation and then restore inference', { timeout: 60000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'let^f=f^ -> (number^,string^){return^1,"s"}');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), fn = () => host.tree.root.fields.items[0].fields.values[0];
            await client.until(`document.querySelector('.svg-export>button') && !document.querySelector('.svg-export>button').disabled`);
            await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
            await client.until(`!document.querySelector('.svg-export>button').disabled`);
            await ui.remove(fn().fields.return_type.fields.items[0]);
            assert.equal(fn().fields.return_type.kind, 'type-name');
            await ui.remove(fn().fields.return_type);
            assert(!fn().fields.return_type);
            assert.equal(fn().fields.body.fields.items[0].fields.value.length, 2);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('computed member receivers keep their member-key expression control during construction', { timeout: 60000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'let^items={1}\nlet^result=items[0]??0');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), get = () => host.tree.root.fields.items[1].fields.values[0];
            await ui.expression(get(), 'member');
            await ui.expression(get().fields.argument[0], 'reference:tostring');
            await ui.expression(get(), 'call');
            assert.equal(get().kind, 'call');
            assert(host.tree.source.includes('.tostring'));
            assert.deepEqual(client.errors, []);
        });
    });
});

test('reassignment index targets expose editable index and receiver expressions', { timeout: 60000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'let^items={}\nlet^i=1\nitems[0]:=7');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), target = () => host.tree.root.fields.items[2].fields.targets[0];
            await ui.expression(target().fields.argument[0], 'reference:i');
            await ui.expression(target().fields.target, 'reference:items');
            const expected = normalizedAst(await parse('let^items={}\nlet^i=1\nitems[i]:=7'));
            assert.deepEqual(normalizedAst(host.tree), expected);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('an overloaded call grows from one to two arguments through its live addition control', { timeout: 60000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'let^values={1,2,3}\nlet^part=values.slice^(0)');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), call = () => host.tree.root.fields.items[1].fields.values[0];
            await ui.addElement('default', call(), 'argument');
            await ui.input(`.box[data-source-start="${call().fields.argument[1].start}"] .literal-input`, '2');
            assert.equal(call().callable.inputs.length, 2);
            assert.equal(call().fields.argument.length, 2);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('unresolved calls retain argument insertion before and after existing values', { timeout: 60000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server, 'let^value=missing()');
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), call = () => host.tree.root.fields.items[0].fields.values[0];
            await ui.addElement('default', call(), 'argument');
            await ui.expression(call().fields.argument[0], 'string');
            await ui.input(`.box[data-source-start="${call().fields.argument[0].start}"] .literal-input`, 'first');
            await ui.addElement('default', call(), 'argument');
            assert.equal(call().fields.argument.length, 2);
            await ui.remove(call().fields.argument[0]);
            assert.equal(call().fields.argument.length, 1);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('loop semantic views retain section contents bounds steps updates and iterator values', { timeout: 120000 }, async () => {
    const source = 'let^run=p^{repeat^17{prolog^:boot(19) pre^:before(23) first^:first(29) main^:work(31) last^:last(37) epilog^:end(41) finally^:cleanup(43)} for^i from^53 downto^47 step^59{visit(i,61)} for^var^v=67 while^ready(v,71) next^v+=73{tick(v,79)} for^item in^{89,97}{see(item,101)}} let^outside=83';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), fn = tree.root.fields.items[0].fields.values[0];
        const flat = n => [n,...Object.values(n.fields ?? {}).flat().flatMap(flat)];
        assert(!flat(tree.root).some(n => n.kind === 'error'), source);
        const groups = [['17','19','23','29','31','37','41','43'],['47','53','59','61'],['67','71','73','79'],['89','97','101']];
        const all = groups.flat().concat('83');
        await browser({ ...routes, '/':{type:'text/html',body:html(tree,false)} }, async client => {
            assert((await svgTexts(client)).join('').includes('run'));
            const check = async selected => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const number of all) assert.equal(texts.filter(t => t === number).length, selected.includes(number) ? 1 : 0, text);
                return text;
            };
            await graphToolbar(client, 'Unfold All');
            const text = await check(all);
            for (const label of ['Before loop','Before each','First iteration','Loop body','Last iteration','After loop','Finally','Down through','Step'])
                assert(text.includes(ja[label]), label + ': ' + text);
            for (const name of ['boot','before','first','work','last','end','cleanup','visit','ready','tick','see']) assert(text.includes(name), name);
            await saveSemanticSvg(client, 'loop-sections-and-modes');
            await graphToolbar(client, 'Fold All'); await drillGraphNode(client, fn); await graphToolbar(client, 'Unfold All');
            await check(groups.flat());
            for (const [index, loop] of fn.fields.body.fields.items.entries()) {
                await graphToolbar(client, 'Fold All'); await drillGraphNode(client, loop);
                await graphToolbar(client, 'Unfold All');
                const text = await check(groups[index]);
                if (index === 1) for (const label of ['Down through','Step']) assert(text.includes(ja[label]), text);
                await saveSemanticSvg(client, `loop-mode-${index}`);
                await client.evaluate('document.querySelector("#trail button").click()'); await graphToolbar(client);
                await graphToolbar(client, 'Fold All'); await drillGraphNode(client, fn); await graphToolbar(client, 'Unfold All');
            }
            assert.equal(await client.evaluate('window.edits.length'), 0); assert.deepEqual(client.errors, []);
        });
    });
});

test('resource bindings add remove and retain their shared body through live controls', { timeout: 120000 }, async () => {
    const { graphHost, graphUi, normalizedAst, load } = require('./graph-browser-host.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const host = await graphHost(parse, server);
        await browser({ ...routes, '/':{type:'text/html',body:html(host.tree,false)} }, async client => {
            const ui = await graphUi(host, client), scope = () => host.tree.root.fields.items[0];
            const bindings = () => scope().fields.items, body = () => scope().fields.extra[0];
            const literal = (node, text) => ui.input(`.box[data-source-start="${node.start}"] .literal-input`, text);
            await ui.add('with'); await graphToolbar(client, 'Unfold All');
            await ui.input(`.name-input[data-reference-start="${bindings()[0].fields.targets[0].start}"]`, 'lease');
            await ui.expression(bindings()[0].fields.values[0], 'number'); await literal(bindings()[0].fields.values[0], '17');
            await ui.structure(scope(), 'resource:add');
            await ui.expression(bindings()[1].fields.values[0], 'string'); await literal(bindings()[1].fields.values[0], 'second');
            const lists = load('graphLists.ts'), deletion = load('graphDelete.ts');
            for (const binding of bindings()) {
                assert(!lists.listInsertions(host.tree).some(s => s.kind === 'define' && s.start === binding.start));
                assert(!deletion.deleteSites(host.tree).some(s => s.start === binding.fields.targets[0].start && s.end === binding.fields.targets[0].end));
            }
            await ui.add('call', body());
            const argument = () => body().fields.items[0].fields.value.fields.argument[0];
            await ui.expression(argument(), 'number'); await literal(argument(), '23');
            await ui.structure(scope(), 'catch:all'); await ui.add('call', body().fields.arms[0].fields.body);
            await ui.structure(scope(), 'finally:add'); await ui.add('call', body().fields.extra[0]);
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('with^lease=17 with^resource="second" {print(23) catch^:print(nil^) finally^:print(nil^)}')), host.tree.source);
            await ui.remove(bindings()[0]);
            assert.deepEqual(normalizedAst(host.tree), normalizedAst(await parse('with^resource="second" {print(23) catch^:print(nil^) finally^:print(nil^)}')), host.tree.source);
            assert(!load('graphStructure.ts').structureTemplates(host.tree, scope()).some(c => c.id.startsWith('remove-resource:')));
            await ui.structure(scope(), 'resource:add'); await ui.remove(bindings()[1]);
            await ui.remove(body().fields.items[0]); await ui.add('call', body());
            await ui.remove(scope()); await ui.add('with'); await ui.remove(scope());
            assert.equal(host.tree.root.fields?.items?.length ?? 0, 0); assert.deepEqual(client.errors, []);
        });
    });
});

test('resource views retain acquisition order local references handlers and disposal scope', { timeout: 90000 }, async () => {
    const source = 'let^run=p^{with^lease=acquire(17) with^spare=acquire(19) {use(lease,23) catch^Issue.Bad:handle(29) finally^:close(31)} after(37)} let^outside=41';
    await require('./lhat-server.cjs').withLhatServer(async parse => {
        const tree = await parse(source), fn = tree.root.fields.items[0].fields.values[0];
        const flat = n => [n,...Object.values(n.fields ?? {}).flat().flatMap(flat)];
        assert(!flat(tree.root).some(n => n.kind === 'error'), source);
        await browser({ ...routes, '/':{type:'text/html',body:html(tree,false)} }, async client => {
            assert((await svgTexts(client)).join('').includes('run'));
            const check = async inside => {
                const texts = await svgTexts(client), text = texts.join('');
                for (const number of ['17','19','23','29','31']) assert.equal(texts.filter(t => t === number).length, 1, text);
                for (const number of ['37','41']) assert.equal(texts.filter(t => t === number).length, inside ? 0 : 1, text);
                for (const value of ['lease','spare','acquire','use','Issue.Bad','handle','close',ja.Catch,ja.Finally]) assert(text.includes(value), value + ': ' + text);
            };
            await graphToolbar(client, 'Unfold All'); await check(false); await saveSemanticSvg(client, 'resource-bindings');
            await graphToolbar(client, 'Fold All'); await drillGraphNode(client, fn);
            await graphToolbar(client, 'Unfold All');
            const texts = await svgTexts(client); assert(texts.includes('37')); assert(!texts.includes('41'));
            await graphToolbar(client, 'Fold All'); await drillGraphNode(client, fn.fields.body.fields.items[0]);
            await graphToolbar(client, 'Unfold All'); await check(true);
            assert.equal(await client.evaluate('window.edits.length'), 0); assert.deepEqual(client.errors, []);
        });
    });
});

test('with bindings and callback interpolations are reconstructed through live controls', { timeout: 120000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    const { reconstruction } = require('./graph-reconstruct.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/zero-based-indices.lh'), 'utf8').replace(/\r\n/g, '\n');
        const original = await parse(source), block = original.root.fields.items.find(n => n.kind === 'with');
        const blueprint = await parse(source.slice(block.start, block.end));
        const expected = normalizedAst(blueprint), host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), builder = reconstruction(ui, host, client, blueprint, message => process.stdout.write(`${message}\n`));
            try { await builder.statements(() => host.tree.root, blueprint.root.fields.items); }
            catch (error) { throw new Error(`${error.message}\nSource: ${host.tree.source}`, { cause: error }); }
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
        });
    });
});

test('inventory definitions are reconstructed with constructors, receivers, errors and focused conditions', { timeout: 600000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    const { reconstruction } = require('./graph-reconstruct.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/inventory.lh'), 'utf8').replace(/\r\n/g, '\n');
        const original = await parse(source), definitions = original.root.fields.items.filter(n => n.kind === 'errordef' || n.kind === 'define' && source.slice(n.fields.targets[0].start, n.fields.targets[0].end) === 'Item');
        const blueprint = await parse(definitions.map(n => source.slice(n.start, n.end)).join('\n'));
        const expected = normalizedAst(blueprint), host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), builder = reconstruction(ui, host, client, blueprint, message => process.stdout.write(`${message}\n`));
            try { await builder.statements(() => host.tree.root, blueprint.root.fields.items); }
            catch (error) { throw new Error(`${error.message}\nSource: ${host.tree.source}`, { cause: error }); }
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('reconstruction selects the variadic marker for typed and inferred element annotations', { timeout: 90000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    const { reconstruction } = require('./graph-reconstruct.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        for (const source of ['let^first=f^...:number^{...[0]}','let^first=f^...{...[0]}']) {
            const blueprint = await parse(source), expected = normalizedAst(blueprint), host = await graphHost(parse, server);
            await browser({ ...routes, '/':{type:'text/html',body:html(host.tree,false)} }, async client => {
                const ui = await graphUi(host, client), builder = reconstruction(ui, host, client, blueprint);
                await builder.statements(() => host.tree.root, blueprint.root.fields.items);
                assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
                assert.deepEqual(client.errors, []);
            });
        }
    });
});

test('inventory sample is reconstructed entirely through live UI controls', { timeout: 2400000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    const { reconstruction } = require('./graph-reconstruct.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/inventory.lh'), 'utf8').replace(/\r\n/g, '\n');
        const blueprint = await parse(source), expected = normalizedAst(blueprint), host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), builder = reconstruction(ui, host, client, blueprint, message => process.stdout.write(`${message}\n`));
            try { await builder.statements(() => host.tree.root, blueprint.root.fields.items); }
            catch (error) { throw new Error(`${error.message}\nSource: ${host.tree.source}`, { cause: error }); }
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('zero-based-indices sample is reconstructed entirely through live UI controls', { timeout: 1800000 }, async () => {
    const { graphHost, graphUi, normalizedAst } = require('./graph-browser-host.cjs');
    const { reconstruction } = require('./graph-reconstruct.cjs');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/zero-based-indices.lh'), 'utf8').replace(/\r\n/g, '\n');
        const blueprint = await parse(source), expected = normalizedAst(blueprint), host = await graphHost(parse, server);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), builder = reconstruction(ui, host, client, blueprint, message => process.stdout.write(`${message}\n`));
            try { await builder.statements(() => host.tree.root, blueprint.root.fields.items); }
            catch (error) { throw new Error(`${error.message}\nSource: ${host.tree.source}`, { cause: error }); }
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});

test('dispatch sample is reconstructed through nested branches, disabled declarations and named types', { timeout: 300000 }, async () => {
    const { graphHost, graphUi, normalizedAst, load } = require('./graph-browser-host.cjs');
    const literals = load('webview/literals.ts'), syntax = load('graphSyntax.ts');
    await require('./lhat-server.cjs').withLhatServer(async (parse, server) => {
        const source = fs.readFileSync(path.join(__dirname, '../testing/dispatch.lh'), 'utf8').replace(/\r\n/g, '\n');
        const blueprint = await parse(source), expected = normalizedAst(blueprint), host = await graphHost(parse, server);
        const text = node => source.slice(node.start, node.end);
        const original = name => blueprint.root.fields.items.find(n => n.kind === 'define' && text(n.fields.targets[0]) === name);
        await browser({ ...routes, '/': { type: 'text/html', body: html(host.tree, false) } }, async client => {
            const ui = await graphUi(host, client), items = () => host.tree.root.fields.items;
            const declaration = name => items().find(n => n.kind === 'define' && host.tree.source.slice(n.fields.targets[0].start, n.fields.targets[0].end) === name);
            const literal = async (node, value) => {
                const current = literals.literalOf(node, host.tree.source);
                if (current?.value !== value) await ui.input(`.box[data-source-start="${node.start}"] .literal-input`, value);
            };
            const rename = async (node, value) => {
                if (host.tree.source.slice(node.start, node.end) !== value) await ui.input(`.name-input[data-reference-start="${node.start}"]`, value);
            };
            const unfold = async () => {
                await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
                await client.until(`!document.querySelector('.svg-export>button').disabled`);
            };
            const comments = async (owner, model) => {
                for (const comment of [...model.comments ?? []].reverse()) {
                    assert.equal(comment.block, false);
                    await ui.add('comment', host.tree.root, owner());
                    await ui.input(`.comment-box[data-source-start="${owner().comments[0].start}"] textarea`, text(comment).slice(1).trim());
                }
            };
            const bodyItems = owner => owner().fields?.items ?? [];
            const append = async (id, owner) => {
                const index = bodyItems(owner).length;
                await ui.add(id, owner());
                assert.equal(bodyItems(owner).length, index + 1, `Append ${id} to ${owner().kind}\n${host.tree.source}`);
                return index;
            };
            const expression = async (get, model) => {
                if (['int', 'float', 'string'].includes(model.kind)) {
                    const kind = model.kind === 'string' ? 'string' : 'number';
                    if (get().kind !== model.kind && !(kind === 'number' && ['int', 'float'].includes(get().kind))) await ui.expression(get(), kind);
                    await literal(get(), model.kind === 'string' ? literals.literalOf(model, source).value : text(model));
                } else if (['ident', 'member', 'hat-ident'].includes(model.kind)) {
                    const value = text(model), id = value === 'nil^' ? 'nil' : value === 'true^' ? 'true' : value === 'false^' ? 'false' : `reference:${value}`;
                    await ui.expression(get(), id);
                } else if (model.kind === 'binary') {
                    await expression(get, model.fields.left); await ui.expression(get(), 'compare');
                    const operator = syntax.syntaxTokens(source, model.fields.left.end, model.fields.right.start).find(t => !['(', ')'].includes(t.text)).text;
                    await ui.operator(get(), operator); await expression(() => get().fields.right, model.fields.right);
                } else if (model.kind === 'if-expr') {
                    await ui.expression(get(), 'conditional');
                    for (let i = 1; i < model.fields.items.filter(n => n.fields.condition).length; i++) await ui.structure(get(), 'branch');
                    for (const [i, branch] of model.fields.items.entries()) {
                        if (branch.fields.condition) await expression(() => get().fields.items[i].fields.condition, branch.fields.condition);
                        await expression(() => get().fields.items[i].fields.body, branch.fields.body);
                    }
                } else if (model.kind === 'interp') {
                    await ui.expression(get(), 'interpolation');
                    const parts = model.fields.items;
                    assert.equal(parts.length, 2);
                    const selector = '.interpolation-field.text textarea';
                    const index = await client.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length - 1`);
                    await ui.input(selector, load('graphInterpolation.ts').interpolationText(text(parts[0])), index);
                    await expression(() => get().fields.items.find(n => n.kind === 'interp-hole').fields.value, parts[1].fields.value);
                } else throw Error(`Unsupported dispatch expression ${model.kind}`);
            };
            const statements = async (owner, models) => {
                for (const model of models) {
                    if (model.kind === 'if-stmt') {
                        const index = await append('if', owner), get = () => bodyItems(owner)[index];
                        const branches = model.fields.items;
                        for (let i = 1; i < branches.filter(n => n.fields.condition).length; i++) await ui.structure(get(), 'branch');
                        if (branches.some(n => !n.fields.condition)) await ui.structure(get(), 'else');
                        for (const [i, branch] of branches.entries()) {
                            if (branch.fields.condition) await expression(() => get().fields.items[i].fields.condition, branch.fields.condition);
                            await statements(() => get().fields.items[i].fields.body, branch.fields.body.fields.items ?? []);
                        }
                    } else if (model.kind === 'call-stmt') {
                        const index = await append('call', owner), get = () => bodyItems(owner)[index].fields.value;
                        await ui.expression(get().fields.target, `reference:${text(model.fields.value.fields.target)}`);
                        const args = model.fields.value.fields.argument ?? [];
                        while ((get().fields.argument?.length ?? 0) > args.length) await ui.remove(get().fields.argument.at(-1));
                        while ((get().fields.argument?.length ?? 0) < args.length) await ui.addElement('default', get(), 'argument');
                        for (const [i, argument] of args.entries()) await expression(() => get().fields.argument[i], argument);
                    } else if (model.kind === 'return') {
                        const index = await append('return', owner), get = () => bodyItems(owner)[index];
                        while ((get().fields?.value?.length ?? 0) < model.fields.value.length) await ui.addElement('number', get(), 'value');
                        for (const [i, value] of model.fields.value.entries()) await expression(() => get().fields.value[i], value);
                    } else throw Error(`Unsupported dispatch statement ${model.kind}`);
                }
            };
            const fn = async (name, before) => {
                const model = original(name).fields.values[0], procedure = text(model).startsWith('p^');
                await ui.add(procedure ? 'procedure' : 'function', host.tree.root, before?.());
                const created = before ? items()[items().indexOf(before()) - 1] : items().at(-1);
                await rename(created.fields.targets[0], name); await unfold();
                const get = () => declaration(name).fields.values[0];
                for (const parameter of model.fields.params ?? []) {
                    await ui.addElement('parameter', get(), 'params');
                    await rename(get().fields.params.at(-1).fields.name, text(parameter.fields.name));
                    const type = parameter.fields.type; assert.equal(type.kind, 'type-name');
                    await ui.typeStructure(get().fields.params.at(-1).fields.name, `type:name:${text(type)}`);
                }
                return get;
            };
            await ui.add('module'); await ui.input('.interpolation-field.module textarea', 'shop.dispatch');
            await ui.add('enumeration'); await unfold();
            let enumeration = () => host.tree.root.fields.items[1];
            await rename(enumeration().fields.name, 'Method');
            for (const [i, name] of ['GET', 'POST', 'PUT', 'DELETE'].entries()) {
                if (i) await ui.addElement('enum', enumeration(), 'members');
                await rename(enumeration().fields.members[i].fields.name, name);
                await ui.structure(enumeration().fields.members[i], 'enum:explicit');
                await ui.expression(enumeration().fields.members[i].fields.members[0], 'string');
                await literal(enumeration().fields.members[i].fields.members[0], name);
            }
            await comments(enumeration, blueprint.root.fields.items[1]); await ui.toggleStatement(enumeration());
            const definition = async name => {
                await ui.add('tableDefinition'); await rename(items().at(-1).fields.targets[0], name);
                await ui.structure(declaration(name), 'public'); await unfold();
                const get = () => declaration(name).fields.values[0];
                await ui.addElement('self', get()); return () => get().fields.items[0].fields.value;
            };
            const body = await definition('Body'); await ui.addElement('member', body()); await rename(body().fields.items[0].fields.key, 'total');
            const request = await definition('Request');
            for (const name of ['method', 'path', 'user', 'body']) {
                await ui.addElement('member', request()); const index = request().fields.items.length - 1, member = () => request().fields.items[index];
                await rename(member().fields.key, name); await ui.expression(member().fields.value, name === 'body' ? 'table' : 'string');
                if (name === 'user') { await ui.type(member().fields.key, 'string^'); await ui.typeStructure(member().fields.key, 'type:nullable'); }
                if (name === 'body') {
                    await ui.addElement('member', member().fields.value); await rename(member().fields.value.fields.items[0].fields.key, 'total');
                    await ui.type(member().fields.key, 't^{}'); await ui.typeStructure(member().fields.key, 'type:name:Body');
                }
            }
            for (const name of ['render', 'addToCart', 'redirect', 'reject', 'notFound', 'charge', 'update', 'remove', 'methodNotAllowed']) await fn(name);
            const before = () => declaration('Body');
            const route = await fn('route', before); await statements(() => route().fields.body, original('route').fields.values[0].fields.body.fields.items);
            await comments(() => declaration('route'), original('route'));
            const grade = await fn('grade', before), gradeModel = original('grade').fields.values[0];
            await expression(() => grade().fields.body.fields.items[0].fields.value[0], gradeModel.fields.body.fields.items[0].fields.value[0]);
            await ui.structure(grade().fields.body.fields.items[0], 'return:implicit'); await ui.type(grade(), 'string^');
            await comments(() => declaration('grade'), original('grade'));
            const describe = await fn('describe', before); await ui.remove(describe().fields.body.fields.items[0]);
            await statements(() => describe().fields.body, original('describe').fields.values[0].fields.body.fields.items);
            await comments(() => declaration('Body'), original('Body'));
            assert.deepEqual(normalizedAst(host.tree), expected, host.tree.source);
            assert.deepEqual(client.errors, []);
        });
    });
});
