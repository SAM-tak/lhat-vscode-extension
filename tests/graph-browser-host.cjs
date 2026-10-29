const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

function load(file, vscode) {
    const entry = path.resolve(__dirname, '../src', file), mod = new Module(entry);
    mod.require = name => name === 'vscode' ? vscode : require(name);
    mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node',
        format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text, entry);
    return mod.exports;
}

/** Run UI messages through the production edit handlers and the real language server. */
async function graphHost(parse, server, initial = '') {
    let tree = await parse(initial), source = initial, version = 1;
    const positionAt = offset => {
        const lines = source.slice(0, offset).split('\n');
        return { line: lines.length - 1, character: lines.at(-1).length };
    };
    const offsetAt = position => source.split('\n').slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character;
    const document = { uri: server.uri, get version() { return version; }, getText: () => source, positionAt, offsetAt };
    class WorkspaceEdit {
        changes = [];
        replace(uri, range, text) { this.changes.push({ uri, range, text }); }
        get size() { return this.changes.length; }
    }
    const vscode = {
        l10n: { t: text => text },
        Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
        Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
        WorkspaceEdit,
        workspace: {
            textDocuments: [document],
            applyEdit: async edit => {
                const changes = edit.changes.map(c => {
                    assert.equal(process.platform === 'win32' ? c.uri.toLowerCase() : c.uri,
                        process.platform === 'win32' ? server.uri.toLowerCase() : server.uri);
                    return { start: offsetAt(c.range.start), end: offsetAt(c.range.end), text: c.text };
                }).sort((a, b) => b.start - a.start);
                for (const c of changes) source = source.slice(0, c.start) + c.text + source.slice(c.end);
                version++; return true;
            },
        },
        commands: { executeCommand: async (command, uri, position, newName) => {
            assert.equal(uri, server.uri);
            if (command === 'vscode.prepareRename') return server.request('textDocument/prepareRename', { textDocument: { uri }, position });
            assert.equal(command, 'vscode.executeDocumentRenameProvider');
            const result = await server.request('textDocument/rename', { textDocument: { uri }, position, newName });
            const edit = new WorkspaceEdit();
            for (const [target, changes] of Object.entries(result?.changes ?? {}))
                for (const c of changes) edit.replace(target, c.range, c.newText);
            return edit;
        } },
    };
    const statements = load('graphStatementEditor.ts', vscode), rename = load('graphRename.ts', vscode), types = load('graphTypeEditor.ts', vscode);
    let typeSelection;
    const host = {
        get tree() { return tree; }, get version() { return version; },
        async typeOptions(message) {
            typeSelection = await types.typeOptionsFromGraph(document, tree, message,
                { sendRequest: (method, params) => server.request(method, params) }, () => true, { isCancellationRequested: false });
            return typeSelection.candidates;
        },
        async edit(message) {
            if (message.type !== 'applyType') assert.equal(message.version, version);
            if (message.type === 'rename') await rename.renameFromGraph(document, message, () => true, tree);
            else if (message.type === 'applyType') {
                assert.equal(message.id, typeSelection?.id);
                await types.applyTypeFromGraph(document, typeSelection, message.typeText, () => true);
                typeSelection = undefined;
            } else if (message.type === 'removeType') await types.removeTypeFromGraph(document, tree, message, () => true);
            else await statements.editStatementFromGraph(document, tree, message,
                { sendRequest: (method, params) => server.request(method, params) }, () => true);
            tree = await parse(source);
        },
        async toggleStatement(context) {
            const Provider = load('graphEditor.ts', vscode).LhatGraphEditorProvider;
            const provider = new Provider({}, () => undefined), panel = { active: true };
            // The browser harness supplies the native shell's panel registry;
            // command validation and source editing remain production code.
            provider.panels.set(context.lhatGraphUri, new Set([panel]));
            let pending;
            provider.statementEditors.set(panel, message => { pending = host.edit(message); });
            provider.toggleStatement(context);
            assert(pending, 'Native context must select a registered statement');
            await pending;
        },
    };
    return host;
}

/** Keep every AST property except coordinates and checker-derived metadata. */
function normalizedAst(tree) {
    const ignored = new Set(['start', 'end', 'line', 'column', 'inferredType', 'inferredReturnType', 'callable']);
    const { syntaxTokens } = load('graphSyntax.ts');
    const visit = node => {
        if (Array.isArray(node)) return node.map(visit);
        if (!node || typeof node !== 'object') return node;
        const result = Object.fromEntries(Object.entries(node).filter(([key]) => !ignored.has(key)).map(([key, value]) => [key, visit(value)]));
        if ('block' in node && !node.kind) {
            const raw = tree.source.slice(node.start, node.end);
            result.text = (node.block ? raw.slice(2, -2) : raw.slice(1)).trim();
        } else if (node.kind && node.kind !== 'block' && !Object.keys(node.fields ?? {}).length)
            result.text = node.kind === 'type-name'
                ? syntaxTokens(tree.source, node.start, node.end).filter(t => !['(', ')'].includes(t.text)).map(t => t.text).join('')
                : tree.source.slice(node.start, node.end);
        return result;
    };
    // AST responses omit operator/modifier tokens. Grouping is already represented
    // by the tree shape, so extra parentheses must not make equivalent trees fail.
    const tokens = syntaxTokens(tree.source).map(t => t.text);
    return { root: visit(tree.root), tokens: tokens.filter((t, i) => t !== '(' && t !== ')'
        && !(t === ',' && ['}', ']', ')'].includes(tokens[i + 1]))) };
}

async function graphUi(host, { evaluate, until, call }) {
    let count = 0;
    const ready = `!document.querySelector('.svg-export>button').disabled`;
    const statements = load('graphStatements.ts'), expressions = load('graphExpressions.ts'), structures = load('graphStructure.ts'), lists = load('graphLists.ts');
    const refresh = async () => {
        await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(host.tree)},uri:'file:///svg-example.lh',version:${host.version}},'*')`);
        await until(`document.querySelector('#app')?.dataset.graphVersion==='${host.version}' && ${ready}`);
    };
    const accept = async () => {
        await until(`window.edits.length===${count + 1}`);
        const message = await evaluate(`window.edits[${count++}]`);
        await host.edit(message);
        const resultType = message.type === 'rename' ? 'renameResult' : ['applyType', 'removeType'].includes(message.type) ? 'typeResult' : 'statementResult';
        await evaluate(`window.postMessage({type:${JSON.stringify(resultType)},id:${JSON.stringify(message.id)}},'*')`);
        await evaluate(`window.postMessage({type:'tree',reply:${JSON.stringify(host.tree)},uri:'file:///svg-example.lh',version:${host.version}},'*')`);
        try {
            await until(`document.querySelector('#app')?.dataset.graphVersion==='${host.version}' && ${ready}`);
        } catch (error) {
            const state = await evaluate(`({app:{...document.querySelector('#app')?.dataset},status:document.querySelector('#status')?.textContent,disabled:document.querySelector('.svg-export>button')?.disabled,visibility:document.visibilityState,focus:document.hasFocus()})`);
            throw new Error(`${error.message}\nGraph state: ${JSON.stringify(state)}\nSource: ${host.tree.source}`, { cause: error });
        }
    };
    const choose = async (selector, choices, id, contextMenu = false) => {
        await until(`document.querySelector(${JSON.stringify(selector)}) && ${ready}`);
        await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].at(-1).${contextMenu
            ? "dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))" : 'click()'}`);
        await until(`document.querySelector('.statement-menu [role=option]')`);
        if (!choices.some(c => c.id === id) && id.startsWith('reference:')) {
            await call('Input.insertText', { text: id.slice(10) });
            await until(`document.querySelector('.statement-menu [role=option]')`);
            await evaluate(`document.querySelector('.statement-menu [role=option]').click()`);
        } else {
            const index = choices.findIndex(c => c.id === id);
            assert(index >= 0, id);
            await evaluate(`document.querySelector('.statement-menu [data-template-index="${index}"]').click()`);
        }
        await accept();
    };
    return {
        async add(id, owner = host.tree.root, before) {
            const site = statements.statementInsertions(host.tree).find(s => s.kind === owner.kind && s.start === owner.start && s.end === owner.end && s.before === before?.start);
            assert(site, `Insertion site for ${owner.kind}`);
            await choose(`[data-insertion-site=${JSON.stringify(JSON.stringify(site))}]`, statements.statementTemplates(host.tree, site), id);
        },
        async expression(node, id) {
            const site = expressions.expressionSites(host.tree).find(s => s.kind === node.kind && s.start === node.start && s.end === node.end);
            assert(site, `Expression site for ${node.kind}`);
            await choose(`.box[data-source-start="${node.start}"][data-source-end="${node.end}"] > .expression-edit`, expressions.expressionTemplates(host.tree, site), id);
        },
        async initializers(owner, id) {
            const site = expressions.expressionSites(host.tree).find(s => s.kind === 'initializers' && s.owner.start === owner.start && s.owner.end === owner.end);
            assert(site);
            await choose(`.box[data-source-start="${owner.start}"][data-source-end="${owner.end}"] > .expression-edit`, expressions.expressionTemplates(host.tree, site), id);
        },
        async addElement(id, owner, field = 'items') {
            const site = lists.listInsertions(host.tree).find(s => s.kind === owner.kind && s.start === owner.start && s.end === owner.end && s.field === field && s.before === undefined);
            assert(site, `Element insertion for ${owner.kind}.${field}: ${JSON.stringify(owner)}\n${host.tree.source}`);
            await choose(`[data-insertion-site=${JSON.stringify(JSON.stringify(site))}]`, lists.listTemplates(host.tree, site), id);
        },
        async structure(node, id) {
            await choose(`.box[data-source-start="${node.start}"] > .structure-edit`, structures.structureTemplates(host.tree, node), id);
        },
        async operator(node, operator) {
            const site = lists.groupedOperatorSites(host.tree).find(s => s.owner.start === node.start && s.owner.end === node.end);
            assert(site?.choices.includes(operator), operator);
            const selector = `.operator-box[data-source-start="${site.start}"]`;
            await until(`document.querySelector(${JSON.stringify(selector)}) && ${ready}`);
            await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
            await until(`document.querySelector('.statement-menu [role=option]')`);
            await evaluate(`document.querySelector('.statement-menu [data-template-index="${site.choices.indexOf(operator)}"]').click()`);
            await accept();
        },
        async remove(node) {
            const selector = `.box[data-source-start="${node.start}"] > .element-delete`;
            await until(`document.querySelector(${JSON.stringify(selector)}) && ${ready}`);
            await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
            await accept();
        },
        async type(name, text) {
            const selector = `.type-label[data-type-start="${name.start}"][data-type-end="${name.end}"]`;
            await until(`document.querySelector(${JSON.stringify(selector)}) && ${ready}`);
            await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
            await until(`window.edits.length===${count + 1}`);
            const request = await evaluate(`window.edits[${count++}]`);
            assert.equal(request.type, 'chooseType');
            if (text === undefined) {
                await until(`document.querySelector('.type-menu-infer:not(:disabled)')`);
                await evaluate(`document.querySelector('.type-menu-infer').click()`);
                await accept(); return;
            }
            const candidates = await host.typeOptions(request);
            assert(candidates.includes(text), `${text} not offered: ${candidates.join(', ')}`);
            await evaluate(`window.postMessage({type:'typeOptions',id:${JSON.stringify(request.id)},candidates:${JSON.stringify(candidates)}},'*')`);
            await until(`document.querySelectorAll('.type-menu [role=option]').length===${candidates.length}`);
            await evaluate(`[...document.querySelectorAll('.type-menu [role=option]')][${candidates.indexOf(text)}].click()`);
            await accept();
        },
        async typeStructure(name, id) {
            const site = load('graphTypes.ts').typeSites(host.tree).find(s => s.start === name.start && s.end === name.end);
            assert(site?.annotation);
            const structure = structures.structureSites(host.tree).filter(s => s.kind.startsWith('type-') &&
                s.start >= site.annotation.start && s.end <= site.annotation.end).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
            assert(structure);
            await choose(`.type-label[data-type-start="${name.start}"][data-type-end="${name.end}"]`, structures.structureTemplates(host.tree, structure), id, true);
        },
        async toggleStatement(node) {
            // VS Code owns this menu. Emulate its contributed entry using only
            // the context rendered by the webview, then invoke the real provider.
            await evaluate(`(()=>{
                const owner=[...document.querySelectorAll('.box[data-vscode-context]')].find(element=>{
                    const context=JSON.parse(element.dataset.vscodeContext);
                    return context.lhatStatement && context.lhatStatementStart===${node.start} && context.lhatStatementEnd===${node.end};
                });
                if(!owner)throw Error('Missing native statement context');
                owner.addEventListener('contextmenu',event=>{
                    event.preventDefault();
                    const context=JSON.parse(owner.dataset.vscodeContext), button=document.createElement('button');
                    button.id='native-toggle-statement';button.textContent='Toggle Disabled Code';
                    button.onclick=()=>{window.nativeStatementContext=context;button.remove()};document.body.append(button);
                },{once:true});
                owner.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
            })()`);
            await until(`document.querySelector('#native-toggle-statement')`);
            await evaluate(`document.querySelector('#native-toggle-statement').click()`);
            const context = await evaluate('window.nativeStatementContext');
            await host.toggleStatement(context); await refresh();
        },
        async input(selector, text, index = 0) {
            await until(`document.querySelectorAll(${JSON.stringify(selector)}).length>${index} && ${ready}`);
            const element = `document.querySelectorAll(${JSON.stringify(selector)})[${index}]`;
            await evaluate(`${element}.focus();${element}.select()`);
            await call('Input.insertText', { text });
            await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await accept();
        },
    };
}

module.exports = { graphHost, graphUi, normalizedAst, load };
