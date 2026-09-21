const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { browser } = require('./browser.cjs');
const ja = require('../l10n/bundle.l10n.ja.json');
const { branchedCalls } = require('./call-tree-fixture.cjs');

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
        const hit = {x:first.x+first.w-12,y:first.y+15};
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

test('a fitting expression is centred as a whole and scrolls from a left-aligned frame in a narrower viewport', { timeout: 60000 }, async () => {
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
