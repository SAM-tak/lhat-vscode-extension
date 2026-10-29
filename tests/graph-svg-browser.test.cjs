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
if(m.type==='chooseType'||m.type==='applyType'||m.type==='removeType'||m.type==='rename'||m.type==='insertElement'||m.type==='replaceOperator'||m.type==='editTextField'||m.type==='insertStatement'||m.type==='editStructure'||m.type==='deleteElement'||m.type==='replaceExpression'||m.type==='editLiteral'||m.type==='editInterpolation'||m.type==='editAnnotation'){window.edits.push(m);${acknowledgeEdits ? "window.postMessage({type:'statementResult',id:m.id},'*');" : ''}}
if(m.type==='saveSvg'){window.exports.push(m);window.postMessage({type:'svgResult',id:m.id},'*');}
if(m.type==='ready'){window.postMessage({type:'localization',language:'ja',bundle:${JSON.stringify(ja)}},'*');window.postMessage({type:'tree',reply:${JSON.stringify(reply)},uri:'file:///svg-example.lh',version:1},'*');}
}});</script><script nonce="test" src="/bundle.js"></script>`;
const routes = { '/': { type: 'text/html', body: html({source,root}) } };
for (const [url, file, type] of [['/graph.css', 'media/graph.css', 'text/css'], ['/bundle.css', 'media/rf/bundle.css', 'text/css'], ['/bundle.js', 'media/rf/bundle.js', 'text/javascript'], ['/layout-worker.js', 'media/rf/layout-worker.js', 'text/javascript']]) {
    routes[url] = { type, body: fs.readFileSync(path.resolve(__dirname, '..', file)) };
}
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
        assert.equal(await evaluate(`document.querySelector('.box[data-source-start="5"] .expression-edit')`), null);
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
        assert.equal(await evaluate(`document.querySelector('.literal-node .element-delete')`), null, 'a scalar value does not delete its enclosing statement');
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
                const selector = `.box[data-source-start="${value.start}"][data-source-end="${value.end}"] > .expression-edit`;
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
                const selector = `.box[data-source-start="${site.start}"][data-source-end="${site.end}"] > .expression-edit`;
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

test('loop controls edit focus initialization, advance, direction and step through the live document', { timeout: 90000 }, async () => {
    const { graphHost, graphUi } = require('./graph-browser-host.cjs');
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
            await ui.structure(match(), 'match-focus:bind');
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
            assert(host.tree.source.includes('(t^{(Item)[]})|nil^'));
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
            await ui.expression(value(), 'nil');
            assert.equal(value().kind, 'hat-ident');
            assert.deepEqual(client.errors, []);
        });
    });
});

test('native statement context disables and restores a UI-created enum through the real server', { timeout: 60000 }, async () => {
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
