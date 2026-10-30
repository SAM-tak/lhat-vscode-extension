const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
function load(file, vscode) {
    const entry = path.resolve(__dirname, '../src', file), mod = new Module(entry);
    mod.require = name => name === 'vscode' ? vscode : require(name);
    mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text, entry);
    return mod.exports;
}
const { annotationOwners, editAnnotation, validAnnotation, annotationOwnerKey, annotationArgumentSpans, annotationArguments, parseAnnotationCatalog, annotationChoicesForOwner, annotationChoiceText } = load('graphAnnotations.ts');
const { placeComments } = load('webview/comments.ts');
const fixture = require('./annotation-fixture.cjs');
const apply = (source, edit) => source.slice(0, edit.start) + edit.text + source.slice(edit.end);
test('annotation recovery keeps unit and declaration ownership, Unicode spans and quoted commas', () => {
    const tree = fixture(), before = JSON.stringify(tree), owners = annotationOwners(tree);
    assert.equal(owners.length, 2);
    assert.deepEqual(owners.map(o => o.annotations.map(a => a.text)), [['@unit'], ['@range(0, 100, "a,b")', '@label("日本語😀")']]);
    assert(owners.every(o => o.annotations.every(a => tree.source.slice(a.start, a.end) === a.text)));
    assert.equal(JSON.stringify(tree), before);
});
test('annotation replacement and removal touch only the selected annotation', () => {
    const tree = fixture(), site = annotationOwners(tree)[1].annotations[0];
    const change = editAnnotation(tree, { ...site, value: '@renamed(-1, true^, HOST_NAME)' });
    assert.equal(apply(tree.source, change), tree.source.replace(site.text, '@renamed(-1, true^, HOST_NAME)'));
    assert.equal(apply(tree.source, editAnnotation(tree, { ...site, value: '' })), tree.source.replace(site.text, ''));
    assert.equal(editAnnotation(tree, { ...site, ownerStart: 999, value: '@bad' }), undefined);
    assert.equal(editAnnotation(tree, { ...site, end: site.end - 1, value: '@bad' }), undefined);
    assert.equal(editAnnotation(tree, { ...site, value: '@bad() let^ injected = 1' }), undefined);
});
test('adding annotations preserves indentation, BOM and CRLF', () => {
    const tree = fixture(), owner = annotationOwners(tree)[1];
    const request = { start: 0, end: 0, ownerStart: owner.start, ownerEnd: owner.end, ownerKind: owner.kind, add: true, value: '@new(2)' };
    assert(apply(tree.source, editAnnotation(tree, request)).includes('@label("日本語😀")\n@new(2)\nlet^'));
    const nestedSource = '\uFEFFmodule^"demo"\r\n{\r\n  let^ n = 1\r\n}';
    const node = { kind: 'define', start: nestedSource.indexOf('let^'), end: nestedSource.indexOf('1') + 1, line: 3, column: 3 };
    const nested = { source: nestedSource, root: { kind: 'block', start: 1, end: nestedSource.length, line: 1, column: 1, fields: { items: [node] } } };
    const edit = editAnnotation(nested, { ...request, ownerStart: node.start, ownerEnd: node.end });
    assert(apply(nestedSource, edit).includes('  @new(2)\r\n  let^ n'));
    const unit = editAnnotation(nested, { ...request, ownerStart: 1, ownerEnd: nestedSource.length, ownerKind: "block" });
    assert(apply(nestedSource, unit).startsWith('\uFEFF@new(2)\r\nmodule^'));
});
test('annotations at the unit head cannot silently be added to the first declaration', () => {
    const source = 'let^ x = 1', node = { kind: 'define', start: 0, end: source.length };
    const tree = { source, root: { kind: 'block', start: 0, end: source.length, fields: { items: [node] } } };
    assert.equal(annotationOwners(tree)[1].canAdd, false);
});
test('only literal and name arguments pass annotation validation', () => {
    for (const text of ['@name', '@名前(-2, 1.5, 1e-2, 0xff, HOST, true^, "a,)b")', '@a()', '@a(1,)', '@é(🚀, `quoted name`, it^^)', '@🚀', '@a(1, # comment\n)']) assert(validAnnotation(text), text);
    for (const text of ['@', '@ a', '@a.b', '@a(x + 1)', '@a(foo())', '@a(1)\nlet^ x = 2', '@a("unterminated)', '@a\n(1)', '@a(,1)', '@a(1,,)', '@a(1 # hidden closing)', '@a(1 #[ hidden closing)', '@`quoted`', '@a^', '@a(1 ≤ 2)']) assert(!validAnnotation(text), text);
});

test('annotation names share lexer Unicode boundaries without allowing hats or quoted names', () => {
    const names = ['é', '🚀', '👩‍💻', '©', '名前'];
    const catalog = parseAnnotationCatalog({ annotations: [...names, '`quoted`', 'bad^', 'a\u2003b', 'a≤b'].map(name => ({ name, targets: { unit: true } })) });
    assert.deepEqual(catalog.map(c => c.name), names);
    for (const name of names) {
        const tree = fixture(`@${name}(🚀)\nmodule^"demo"\nlet^ value = 1`);
        const site = annotationOwners(tree)[0].annotations[0];
        assert.equal(site.text, `@${name}(🚀)`);
        assert.deepEqual(annotationArguments(site.text), { name, arguments: '🚀' });
        assert(validAnnotation(site.text));
    }
    const tree = fixture('@name\n(1)\nmodule^"demo"\nlet^ value = 1');
    assert.equal(annotationOwners(tree)[0].annotations[0].text, '@name', 'a new line prevents an argument list');
});
test('annotation lists occupy the left side, group by owner and fold as a group', () => {
    const tree = fixture(), node = tree.root.fields.items[1], sites = annotationOwners(tree)[1].annotations;
    const make = () => ({ id: 'root', width: 120, height: 90, children: [{ id: 'owner', x: 10, y: 10, width: 100, height: 30, lhat: { ...node } }] });
    const graph = placeComments(make(), tree), notes = graph.children.filter(c => c.lhat?.annotationList);
    assert.equal(notes.length, 2);
    assert.deepEqual(notes.map(n => n.lhat.annotationList.annotations.length), [1, 2]);
    const owner = graph.children.find(c => c.id === 'owner'), list = notes.find(n => n.lhat.commentAnchor);
    assert(list.x + list.width < owner.x);
    assert.equal(list.y, owner.y);
    assert.equal(list.lhat.commentAnchor.id, owner.id);
    assert(list.lhat.commentAnchor.dx < 0);
    assert(list.labels[0].text.startsWith('range('));
    assert(!list.labels[0].text.includes('@'));
    const folded = placeComments(make(), tree, { collapseAll: true }).children.filter(c => c.lhat?.annotationList);
    assert(folded.every(c => c.lhat.collapsed));
    assert(folded[1].height < list.height);
    const foldedOwner = make(); foldedOwner.children[0].lhat.collapsed = true;
    assert.equal(placeComments(foldedOwner, tree).children.filter(c => c.lhat?.annotationList).length, 2);
    const drilled = { id: 'view', width: 120, height: 30, children: [] };
    const drilledNotes = placeComments(drilled, tree, { root: node }).children.filter(c => c.lhat?.annotationList);
    assert.equal(drilledNotes.length, 1);
    assert.equal(drilledNotes[0].lhat.annotationList.annotations.length, 2);
});

test('recovery ignores annotation-like text in multiline strings and disabled code', () => {
    const source = 'module^"demo"\nlet^ text = """\n@fake\ntext\nlet^ x = 1';
    const start = source.indexOf('"""'), end = source.indexOf('let^ x');
    const tree = { source, root: { kind: 'block', start: 0, end: source.length, fields: { items: [
        { kind: 'string', start, end }, { kind: 'define', start: end, end: source.length },
    ] } } };
    assert(annotationOwners(tree).every(o => !o.annotations.length));
});

test('annotation host edits validate snapshot and apply exactly one undoable replacement', async () => {
    const tree = fixture(), site = annotationOwners(tree)[1].annotations[0], edits = [];
    const document = { uri: 'file:annotation', version: 7, getText: () => tree.source, positionAt: character => ({ line: 0, character }) };
    const mock = { l10n: { t: text => text }, Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
        WorkspaceEdit: class { changes = []; replace(uri, range, text) { this.changes.push({ uri, range, text }); } },
        workspace: { applyEdit: async edit => { edits.push(edit); return true; } } };
    const { editStatementFromGraph } = load('graphStatementEditor.ts', mock);
    const message = { type: 'editAnnotation', id: 'edit', version: 7, ...site, value: '@updated(5)' };
    await editStatementFromGraph(document, tree, message, undefined, () => true);
    assert.equal(edits.length, 1); assert.equal(edits[0].changes.length, 1);
    assert.equal(edits[0].changes[0].range.start.character, site.start);
    assert.equal(edits[0].changes[0].text, '@updated(5)');
    for (const version of [6, 8]) await assert.rejects(editStatementFromGraph(document, tree, { ...message, version }, undefined, () => true));
    await assert.rejects(editStatementFromGraph(document, tree, message, undefined, () => false));
    document.getText = () => tree.source + ' ';
    await assert.rejects(editStatementFromGraph(document, tree, message, undefined, () => true));
    assert.equal(edits.length, 1);
});

test('unfinished annotation input does not crash the graph while typing', () => {
    for (const source of ['@', '@valid @', '@valid(1,', '@valid @(']) {
        const tree = { source, root: { kind: 'block', start: 0, end: source.length } };
        assert.doesNotThrow(() => annotationOwners(tree));
    }
});

test('registered annotations supply target-filtered names and signature-driven parameter defaults', () => {
    const choices = parseAnnotationCatalog({ annotations: [
        { module: 'godot', name: 'range', targets: { field: true }, signature: 'f^ number^, number^, ...;' },
        { module: 'godot', name: 'game', targets: { binding: true } },
        { name: '@bad', targets: { binding: true } },
    ] });
    assert.equal(choices.length, 2);
    assert.deepEqual(choices[0].parameterTypes, ['number^', 'number^']);
    assert.equal(choices[0].variadic, true);
    assert.equal(annotationChoiceText(choices[0]), '@range(0, 0)');
    assert.equal(annotationChoiceText(choices[0], '@old(2, 8)'), '@range(2, 8)');
    assert.deepEqual(annotationArguments('@range(0, "a,b")'), { name: 'range', arguments: '0, "a,b"' });
    const tree = fixture(), owner = annotationOwners(tree)[1];
    assert.deepEqual(annotationChoicesForOwner(tree, owner).map(c => c.name), ['export_class', 'export_range', 'game']);
    const selected = annotationChoicesForOwner(tree, owner, owner.annotations[0]);
    assert(selected.some(c => c.name === 'range'));
    assert(!selected.some(c => c.name === 'unit'));
    assert.equal(annotationChoiceText({ name: 'export_class', parameterTypes: [] }, '@range(2, 3)'), '@export_class');
});

test('a grouped sidebar stays outside a definition row and clears adjacent code and comments', () => {
    const tree = fixture(), node = tree.root.fields.items[1];
    const row = { id: 'row', x: 10, y: 10, width: 160, height: 40, lhat: { ...node, kind: 'define-row', definitionRole: 'row' },
        children: [{ id: 'declaration', x: 0, y: 0, width: 60, height: 30, lhat: { ...node, definitionRole: 'declaration' } }] };
    const next = { id: 'next', x: 10, y: 80, width: 30, height: 30 }, right = { id: 'right', x: 190, y: 10, width: 30, height: 30 };
    const graph = placeComments({ id: 'view', width: 230, height: 120, children: [row, next, right] }, tree);
    const sidebar = graph.children.find(c => c.lhat?.commentAnchor?.id === 'row');
    assert(sidebar); assert(sidebar.x + sidebar.width < row.x);
    assert(next.y > sidebar.y + sidebar.height);
    assert(right.x >= row.x + row.width + 20);
    assert.equal(row.x, next.x, "sidebars preserve the shared statement column");
    for (const child of graph.children) {
        assert(child.x >= 0 && child.y >= 0);
        assert(child.x + child.width <= graph.width);
        assert(child.y + child.height <= graph.height);
    }
});

test('catalog lookup respects nearest project boundaries and open unsaved configuration', async () => {
    const entries = { annotations: [{ module: 'godot', name: 'game', targets: { binding: true } }] };
    const uri = path => ({ path, toString: () => `file://${path}` });
    const paths = new Map([['/workspace/lhat-host.json', JSON.stringify(entries)]]);
    class FileSystemError extends Error { code = 'FileNotFound'; }
    const mock = { FileSystemError, Uri: { joinPath: (base, ...parts) => uri(path.posix.join(base.path, ...parts)) },
        workspace: { textDocuments: [], getWorkspaceFolder: () => ({ uri: uri('/workspace') }), fs: {
            readFile: async value => { if (!paths.has(value.path)) throw new FileSystemError(); return new TextEncoder().encode(paths.get(value.path)); },
        } } };
    const { readAnnotationCatalog } = load('graphAnnotationCatalog.ts', mock);
    const document = { uri: uri('/workspace/sub/program.lh') };
    assert.deepEqual((await readAnnotationCatalog(document)).map(c => c.name), ['game']);
    paths.set('/workspace/sub/lhat-lsp.json', '{}');
    assert.deepEqual(await readAnnotationCatalog(document), [], 'a nested project cannot borrow the outer host registrations');
    paths.set('/workspace/sub/lhat-host.json', '{bad json');
    assert.deepEqual(await readAnnotationCatalog(document), []);
    mock.workspace.textDocuments.push({ uri: uri('/workspace/sub/lhat-host.json'), getText: () => JSON.stringify(entries) });
    assert.deepEqual((await readAnnotationCatalog(document)).map(c => c.name), ['game']);
});

test('new annotations append after existing entries and comments, including unit annotations', () => {
    const tree = fixture(), owners = annotationOwners(tree);
    for (const owner of owners) {
        const change = editAnnotation(tree, { start: 0, end: 0, ownerStart: owner.start, ownerEnd: owner.end, ownerKind: owner.kind, add: true, value: '@last' });
        const result = apply(tree.source, change);
        assert(result.indexOf('@last') > result.indexOf(owner.annotations.at(-1).text));
    }
    const source = 'module^"demo"\r\n  @first # keep this comment\r\n  let^ x = 1';
    const node = { kind: 'define', start: source.indexOf('let^'), end: source.length };
    const nested = { source, root: { kind: 'block', start: 0, end: source.length, fields: { items: [node] } } };
    const change = editAnnotation(nested, { start: 0, end: 0, ownerStart: node.start, ownerEnd: node.end, ownerKind: 'define', add: true, value: '@last' });
    assert.equal(apply(source, change), source.replace('  let^', '  @last\r\n  let^'));
});

test('native annotation action shows a box without choosing a name or changing source', async () => {
    for (const tree of [fixture('@unit\nmodule^"demo"\nlet^ value = 1'), fixture()]) {
        const owner = annotationOwners(tree)[1], messages = [], changes = [];
        const document = { uri: { toString: () => 'file:annotations' }, version: 1, getText: () => tree.source };
        let receive, dispose;
        const mock = { env: { language: 'en' }, l10n: { t: text => text }, Uri: { joinPath: (base, ...parts) => [base, ...parts].join('/') },
            window: { showQuickPick: () => { throw Error('must not choose a name when opening the box'); } },
            workspace: { getConfiguration: () => ({ get: () => 'en' }), onDidChangeTextDocument: () => ({ dispose() {} }),
                onDidChangeConfiguration: () => ({ dispose() {} }), applyEdit: async edit => { changes.push(edit); return true; } } };
        const panel = { active: true, onDidDispose: callback => { dispose = callback; }, webview: { asWebviewUri: uri => uri, cspSource: 'test:',
            postMessage: message => { messages.push(message); return Promise.resolve(true); }, onDidReceiveMessage: callback => { receive = callback; } } };
        const Provider = load('graphEditor.ts', mock).LhatGraphEditorProvider;
        const provider = new Provider({ extensionUri: 'test:extension' }, () => ({ sendRequest: async () => tree }));
        await provider.resolveCustomTextEditor(document, panel, {}); receive({ type: 'ready' }); await new Promise(setImmediate);
        const context = { lhatCanAddAnnotation: true, lhatGraphUri: 'file:annotations', lhatGraphVersion: 1,
            lhatAnnotationStart: owner.start, lhatAnnotationEnd: owner.end, lhatAnnotationKind: owner.kind };
        await provider.addAnnotation(context);
        assert.deepEqual(messages.at(-1), { type: 'showAnnotations', ownerStart: owner.start, ownerEnd: owner.end, ownerKind: owner.kind, version: 1 });
        assert.equal(changes.length, 0); assert.equal(document.getText(), tree.source);
        document.version++;
        await assert.rejects(provider.addAnnotation(context), /source changed/);
        const count = messages.length;
        dispose(); await provider.addAnnotation(context);
        assert.equal(messages.length, count);
    }
});

test('unsaved annotation removals use the live buffer instead of the previous checked source', async () => {
    const saved = fixture('@unit\nmodule^"demo"\n@game @export_class\npublic^let^ value = 1');
    let live = fixture(saved.source.replace('@game @export_class\n', '')), checked = saved;
    const document = { uri: { toString: () => 'file:unsaved' }, version: 2, isDirty: true,
        getText: () => live.source, save: () => { throw Error('must not save'); } };
    const messages = [], edits = [];
    let receive, changed, dispose;
    const mock = { env: { language: 'en' }, l10n: { t: text => text }, Uri: { joinPath: (base, ...parts) => [base, ...parts].join('/') },
        workspace: { getConfiguration: () => ({ get: () => 'en' }), onDidChangeTextDocument: callback => { changed = callback; return { dispose() {} }; },
            onDidChangeConfiguration: () => ({ dispose() {} }), applyEdit: async edit => { edits.push(edit); return true; } } };
    const panel = { active: true, onDidDispose: callback => { dispose = callback; }, webview: { asWebviewUri: uri => uri, cspSource: 'test:',
        postMessage: message => { messages.push(message); return Promise.resolve(true); }, onDidReceiveMessage: callback => { receive = callback; } } };
    const Provider = load('graphEditor.ts', mock).LhatGraphEditorProvider;
    const provider = new Provider({ extensionUri: 'test:extension' }, () => ({ sendRequest: async () => checked }));
    const owner = annotationOwners(live)[1];
    const context = { lhatCanAddAnnotation: true, lhatGraphUri: 'file:unsaved', lhatGraphVersion: 2,
        lhatAnnotationStart: owner.start, lhatAnnotationEnd: owner.end, lhatAnnotationKind: owner.kind };
    await provider.resolveCustomTextEditor(document, panel, {});
    try {
        receive({ type: 'ready' }); await new Promise(setImmediate);
        assert(messages.some(m => m.type === 'pending'));
        assert(!messages.some(m => m.type === 'tree'));
        await assert.rejects(provider.addAnnotation(context), /source changed/);
        checked = live;
        receive({ type: 'refresh' }); await new Promise(setImmediate);
        const latest = messages.filter(m => m.type === 'tree').at(-1);
        assert.equal(latest.reply.source, document.getText()); assert.equal(latest.version, 2);
        await provider.addAnnotation(context);
        assert.equal(messages.at(-1).type, 'showAnnotations');
        const names = annotationChoicesForOwner(latest.reply, annotationOwners(latest.reply)[1]).map(c => c.name);
        assert(names.includes('game') && names.includes('export_class'));
        live = fixture(live.source + '\n'); document.version++;
        changed({ document });
        assert.equal(messages.at(-1).type, 'pending');
        await assert.rejects(provider.addAnnotation(context), /source changed/);
        assert.equal(edits.length, 0); assert(saved.source.includes('@game @export_class')); assert(document.isDirty);
    } finally { dispose(); }
});

test('an explicitly opened empty annotation box has geometry without changing the AST or source', () => {
    const tree = fixture('@unit\nmodule^"demo"\nlet^ value = 1'), original = JSON.stringify(tree);
    const owner = annotationOwners(tree)[1];
    const make = () => ({ id: 'root', width: 120, height: 90, children: [{ id: 'owner', x: 10, y: 10, width: 100, height: 30, lhat: { ...tree.root.fields.items[1] } }] });
    assert.equal(placeComments(make(), tree).children.filter(c => c.lhat?.annotationList).length, 1);
    const graph = placeComments(make(), tree, { annotationBoxes: { [annotationOwnerKey(owner)]: true } });
    const box = graph.children.find(c => c.lhat?.annotationList?.kind === 'define');
    assert(box && box.width > 0 && box.height > 0);
    assert.deepEqual(box.lhat.annotationList.annotations, []);
    assert(box.x + box.width < graph.children.find(c => c.id === 'owner').x);
    assert.equal(JSON.stringify(tree), original);
    assert.equal(placeComments(make(), tree).children.filter(c => c.lhat?.annotationList).length, 1);
});

test('individual annotation parameter fields preserve quoted commas and source separators', () => {
    const { annotationPresentation, annotationParameterText } = load('webview/annotations.ts');
    const text = '@range(-2, 100, "a,b", HOST_NAME)', site = { start: 0, end: text.length, ownerStart: 0, ownerEnd: 10, ownerKind: 'define', text };
    assert.deepEqual(annotationArgumentSpans(text).map(span => span.text), ['-2', '100', '"a,b"', 'HOST_NAME']);
    const view = annotationPresentation(site);
    assert.deepEqual(view.parameters.map(p => p.kind), ['number', 'number', 'string', 'name']);
    assert.deepEqual(view.parameters.map(p => p.value), ['-2', '100', 'a,b', 'HOST_NAME']);
    assert.equal(annotationParameterText(text, view.parameters[1], '400'), '@range(-2, 400, "a,b", HOST_NAME)');
    assert.equal(annotationParameterText(text, view.parameters[2], 'new, "text"'), '@range(-2, 100, ' + JSON.stringify('new, "text"') + ', HOST_NAME)');
    const plain = annotationPresentation({ ...site, text: '@export_class' });
    assert.equal(plain.parameters.length, 0); assert(plain.width < 128);
});
