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
const html = reply => `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'nonce-test'; connect-src 'self'; worker-src blob:;"><style>:root {
--vscode-editor-background:#111314;--vscode-editor-foreground:#ddd;--vscode-editor-font-family:Consolas,monospace;
--vscode-editorWidget-background:#222;--vscode-editorWidget-border:#333;--vscode-input-background:#151718;
--vscode-input-foreground:#ddd;--vscode-focusBorder:#58a;--vscode-descriptionForeground:#999;
}</style><link rel="stylesheet" href="/graph.css"><link rel="stylesheet" href="/bundle.css"><div id="root" data-layout-worker="/layout-worker.js"></div><script nonce="test">
window.exports=[];window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(m){
if(m.type==='saveSvg'){window.exports.push(m);window.postMessage({type:'svgResult',id:m.id},'*');}
if(m.type==='ready'){window.postMessage({type:'localization',language:'ja',bundle:${JSON.stringify(ja)}},'*');window.postMessage({type:'tree',reply:${JSON.stringify(reply)},uri:'file:///svg-example.lh',version:1},'*');}
}});</script><script nonce="test" src="/bundle.js"></script>`;
const routes = { '/': { type: 'text/html', body: html({source,root}) } };
for (const [url, file, type] of [['/graph.css', 'media/graph.css', 'text/css'], ['/bundle.css', 'media/rf/bundle.css', 'text/css'], ['/bundle.js', 'media/rf/bundle.js', 'text/javascript'], ['/layout-worker.js', 'media/rf/layout-worker.js', 'text/javascript']]) {
    routes[url] = { type, body: fs.readFileSync(path.resolve(__dirname, '..', file)) };
}
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
            const boxes=[...document.querySelectorAll('.box')].map(box=>box.getBoundingClientRect());
            let collisions=0;
            for(const path of document.querySelectorAll('.react-flow__edge-operand-definition .react-flow__edge-path')) {
                const matrix=path.getScreenCTM(), length=path.getTotalLength();
                for(let t=2;t<length-2;t+=2) {
                    const p=path.getPointAtLength(t), point=new DOMPoint(p.x,p.y).matrixTransform(matrix);
                    if(boxes.some(r=>point.x>r.left+1 && point.x<r.right-1 && point.y>r.top+1 && point.y<r.bottom-1)) collisions++;
                }
            }
            return {rows:rows.length,slots:document.querySelectorAll('.operand-slot').length,
                calls:document.querySelectorAll('.call-node').length,collisions,
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
        assert.equal((await inspect()).collisions, 0);
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
                ...rect(e),text:e.querySelector('.comment-text').textContent,title:e.title,handles:e.parentElement.querySelectorAll('.react-flow__handle').length,
                overflow:e.scrollHeight>e.clientHeight}))};
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
        const toggle = async () => {
            const point = await evaluate(`(()=>{const r=document.querySelectorAll('.comment-box .foldbtn')[1].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
            await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
            await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        };
        await toggle();
        await until(`document.querySelectorAll('.comment-box .foldbtn')[1].getAttribute('aria-expanded')==='false' && !document.querySelector('.svg-export>button').disabled`);
        assert.equal(await evaluate(`document.querySelectorAll('.comment-text')[1].textContent`), '日本語のコメント…');
        assert(await evaluate(`document.querySelectorAll('.comment-box')[1].getBoundingClientRect().height`) < result.comments[1].h);
        await toggle();
        await until(`document.querySelectorAll('.comment-box .foldbtn')[1].getAttribute('aria-expanded')==='true' && !document.querySelector('.svg-export>button').disabled`);
        assert.equal(await evaluate(`document.querySelectorAll('.comment-text')[1].textContent`), result.comments[1].text);
        assert.equal(await evaluate(`document.querySelectorAll('.comment-box')[1].getBoundingClientRect().height`), result.comments[1].h);
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
                        (box.classList.contains('return-node') || (!box.classList.contains('container') && !box.classList.contains('condition-node')));
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
