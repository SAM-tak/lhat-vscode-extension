const assert = require('node:assert/strict');
const { load } = require('./graph-browser-host.cjs');

// A blueprint supplies desired names, literal values and structural choices.
// Every change still goes through a rendered control and the real editing host.
function reconstruction(ui, host, client, blueprint) {
    const source = blueprint.source, text = node => source.slice(node.start, node.end);
    const { syntaxTokens } = load('graphSyntax.ts'), { literalOf } = load('webview/literals.ts');
    const { iteratorNames } = load('graphLoops.ts'), { assignmentValues, assignmentOperator } = load('graphAssignments.ts');
    const { interpolationText } = load('graphInterpolation.ts');
    const { validReference } = load('graphExpressions.ts');
    const one = (node, field) => Array.isArray(node.fields?.[field]) ? node.fields[field][0] : node.fields?.[field];
    const array = (node, field) => node.fields?.[field] ?? [];
    const written = node => host.tree.source.slice(node.start, node.end);
    const name = node => one(node, 'name') ?? node;
    const rename = async (node, value) => {
        if (written(node) !== value) await ui.input(`.name-input[data-reference-start="${node.start}"]`, value);
    };
    const literal = async (node, value) => {
        if (literalOf(node, host.tree.source)?.value !== value)
            await ui.input(`.box[data-source-start="${node.start}"] .literal-input`, value);
    };
    const unfold = async () => {
        await client.evaluate(`[...document.querySelectorAll('#bar button')].find(b=>b.textContent==='Unfold All')?.click()`);
        await client.until(`!document.querySelector('.svg-export>button').disabled`);
    };
    const annotate = async (get, model) => {
        if (!model) { await ui.type(name(get()), undefined); return; }
        if (model.kind === 'type-name') await ui.typeStructure(name(get()), `type:name:${text(model)}`);
        else if (model.kind === 'type-table') {
            const item = array(model, 'items')[0];
            assert.equal(array(model, 'items').length, 1);
            assert.equal(one(item, 'value').kind, 'type-name');
            await ui.typeStructure(name(get()), `type:name:${text(one(item, 'value'))}`);
            await ui.typeStructure(name(get()), 'type:sequence');
        } else throw Error(`Unsupported constructed type ${model.kind}`);
    };
    const parameters = async (get, models) => {
        for (const [i, model] of models.entries()) {
            const variadic = !one(model, 'name');
            await ui.addElement(variadic ? 'variadic' : 'parameter', get(), 'params');
            const param = () => get().fields.params[i];
            if (!variadic) await rename(one(param(), 'name'), text(one(model, 'name')));
            await annotate(() => variadic ? one(param(), 'type') : param(), one(model, 'type'));
        }
    };
    const binaryTemplate = operator => ['and^', 'or^'].includes(operator) ? 'logical'
        : operator === '??' ? 'fallback' : ['=', '==', '!=', '<', '>', '<=', '>=', '≦', '≧'].includes(operator) ? 'compare' : 'add';
    const expression = async (get, model) => {
        assert(get(), `Missing expression for ${text(model)}`);
        const decoded = literalOf(model, source);
        if (decoded) {
            if (!literalOf(get(), host.tree.source) || literalOf(get(), host.tree.source).kind !== decoded.kind)
                await ui.expression(get(), decoded.kind === 'string' ? 'string' : 'number');
            await literal(get(), decoded.value); return;
        }
        if (['ident', 'hat-ident'].includes(model.kind) || model.kind === 'member' && validReference(text(model))) {
            const value = text(model), id = { 'true^': 'true', 'false^': 'false', 'nil^': 'nil' }[value] ?? `reference:${value}`;
            await ui.expression(get(), id); return;
        }
        if (model.kind === 'binary') {
            const left = one(model, 'left'), right = one(model, 'right');
            const operator = syntaxTokens(source, left.end, right.start).find(t => !['(', ')'].includes(t.text)).text;
            await expression(get, left); await ui.expression(get(), binaryTemplate(operator));
            const currentLeft = one(get(), 'left'), currentRight = one(get(), 'right');
            const currentOperator = syntaxTokens(host.tree.source, currentLeft.end, currentRight.start).find(t => !['(', ')'].includes(t.text)).text;
            if (operator !== currentOperator) await ui.operator(get(), operator);
            await expression(() => one(get(), 'right'), right); return;
        }
        if (model.kind === 'unary') {
            const operand = one(model, 'operand') ?? one(model, 'value');
            await expression(get, operand);
            const postfix = syntaxTokens(source, operand.end, model.end).some(t => t.text === '?');
            await ui.expression(get(), postfix ? 'present' : syntaxTokens(source, model.start, operand.start)[0]?.text === '!' ? 'not' : 'negative');
            return;
        }
        if (['try', 'pack'].includes(model.kind)) {
            await expression(get, one(model, 'value')); await ui.expression(get(), model.kind); return;
        }
        if (model.kind === 'member') {
            await expression(get, one(model, 'target')); await ui.expression(get(), 'member');
            await ui.expression(one(get(), 'argument'), `reference:${text(one(model, 'argument'))}`); return;
        }
        if (model.kind === 'index') {
            await expression(get, one(model, 'target')); await ui.expression(get(), 'index');
            assert.equal(array(model, 'argument').length, 1);
            await expression(() => one(get(), 'argument'), one(model, 'argument')); return;
        }
        if (model.kind === 'call') {
            await expression(get, one(model, 'target')); await ui.expression(get(), 'call');
            const args = array(model, 'argument');
            while (array(get(), 'argument').length > args.length) await ui.remove(array(get(), 'argument').at(-1));
            while (array(get(), 'argument').length < args.length) await ui.addElement('default', get(), 'argument');
            for (const [i, argument] of args.entries()) await expression(() => array(get(), 'argument')[i], argument);
            return;
        }
        if (model.kind === 'table') {
            await ui.expression(get(), 'table');
            for (const [i, entry] of array(model, 'items').entries()) {
                assert(!one(entry, 'key'));
                await ui.addElement('number', get());
                await expression(() => one(array(get(), 'items')[i], 'value'), one(entry, 'value'));
            }
            return;
        }
        if (model.kind === 'func') {
            const procedure = syntaxTokens(source, model.start, model.end)[0].text === 'p^';
            await ui.expression(get(), procedure ? 'procedure' : 'function'); await unfold();
            await parameters(get, array(model, 'params'));
            if (!procedure) await ui.remove(array(one(get(), 'body'), 'items')[0]);
            await statements(() => one(get(), 'body'), array(one(model, 'body'), 'items')); return;
        }
        if (model.kind === 'tuple') {
            await ui.expression(get(), 'tuple');
            const values = array(model, 'items');
            while (array(get(), 'items').length < values.length) await ui.addElement('number', get());
            for (const [i, value] of values.entries()) await expression(() => array(get(), 'items')[i], value);
            return;
        }
        if (model.kind === 'interp') {
            await ui.expression(get(), 'interpolation');
            const parts = array(model, 'items');
            // Drop the template prefix when the written interpolation starts with a hole.
            const firstText = array(get(), 'items')[0];
            await ui.input(`.box[data-source-start="${firstText.start}"] .interpolation-field.text textarea`,
                parts[0].kind === 'interp-text' ? interpolationText(text(parts[0])) : '');
            let hole = 0;
            for (const [i, part] of parts.entries()) {
                if (part.kind === 'interp-text') {
                    if (i === 0) continue;
                    await ui.interpolationPart(get(), 'text');
                    const current = array(get(), 'items').at(-1);
                    const value = interpolationText(text(part));
                    if (value !== 'text') await ui.input(`.box[data-source-start="${current.start}"] .interpolation-field.text textarea`, value);
                } else {
                    if (hole) await ui.interpolationPart(get(), 'expression');
                    const index = hole++;
                    await expression(() => one(array(get(), 'items').filter(n => n.kind === 'interp-hole')[index], 'value'), one(part, 'value'));
                }
            }
            return;
        }
        throw Error(`Unsupported expression ${model.kind}: ${text(model)}`);
    };
    const addComments = async (owner, comments) => {
        for (const comment of comments ?? []) {
            assert(!comment.block);
            await ui.add('comment', owner());
            const fields = load('graphTextFields.ts').textFields(host.tree).filter(f => f.site.field === 'comment');
            const added = fields.sort((a, b) => b.site.start - a.site.start)[0];
            await ui.input(`.comment-box[data-source-start="${added.site.start}"] textarea`, text(comment).slice(1).trim());
        }
    };
    const statements = async (owner, models) => {
        for (const model of models) {
            await addComments(owner, model.comments);
            const index = array(owner(), 'items').length;
            const get = () => array(owner(), 'items')[index];
            const append = async id => { await ui.add(id, owner()); assert(get(), `Append ${id}`); };
            if (model.kind === 'import-stmt') {
                await append('import');
                await ui.input(`.box[data-source-start="${get().start}"] .interpolation-field.import textarea`, text(one(model, 'value') ?? one(model, 'name')));
            } else if (model.kind === 'define') {
                const mutable = syntaxTokens(source, model.start, model.end)[0].text === 'var^';
                await append(mutable ? 'var' : 'let');
                assert.equal(array(model, 'targets').length, 1);
                await rename(name(one(get(), 'targets')), text(name(one(model, 'targets'))));
                await expression(() => one(get(), 'values'), one(model, 'values'));
                const annotation = one(one(model, 'targets'), 'type');
                if (annotation) {
                    await ui.type(name(one(get(), 'targets')), 't^{}');
                    await annotate(() => one(get(), 'targets'), annotation);
                }
            } else if (model.kind === 'call-stmt') {
                await append('call'); await expression(() => one(get(), 'value'), one(model, 'value'));
            } else if (model.kind === 'reassign') {
                await append('assign');
                assert.equal(array(model, 'targets').length, 1);
                await expression(() => one(get(), 'targets'), one(model, 'targets'));
                await ui.structure(get(), `assignment:${assignmentOperator(model, source).base}`);
                await expression(() => assignmentValues(get(), host.tree.source)[0], assignmentValues(model, source)[0]);
            } else if (model.kind === 'return') {
                await append('return'); const values = array(model, 'value');
                while (array(get(), 'value').length < values.length) await ui.addElement('number', get(), 'value');
                for (const [i, value] of values.entries()) await expression(() => array(get(), 'value')[i], value);
                if (syntaxTokens(source, model.start, model.end)[0]?.text !== 'return^') await ui.structure(get(), 'return:implicit');
            } else if (model.kind === 'panic') {
                await append('panic'); await expression(() => one(get(), 'value'), one(model, 'value'));
            } else if (model.kind === 'if-stmt') {
                await append('if'); const arms = array(model, 'items');
                for (let i = 1; i < arms.filter(a => one(a, 'condition')).length; i++) await ui.structure(get(), 'branch');
                if (arms.some(a => !one(a, 'condition'))) await ui.structure(get(), 'else');
                for (const [i, arm] of arms.entries()) {
                    const current = () => array(get(), 'items')[i];
                    if (one(arm, 'condition')) await expression(() => one(current(), 'condition'), one(arm, 'condition'));
                    await statements(() => one(current(), 'body'), array(one(arm, 'body'), 'items'));
                }
            } else if (model.kind === 'for') {
                await append('for');
                const names = iteratorNames(model, source);
                if (names.length) {
                    await ui.structure(get(), 'mode:iterator');
                    if (names.length === 2) await ui.structure(get(), 'iterator:key:add');
                    for (const [i, n] of names.entries()) await rename(iteratorNames(get(), host.tree.source)[i], text(n));
                } else {
                    await rename(one(one(get(), 'focus'), 'targets'), text(one(one(model, 'focus'), 'targets')));
                    await expression(() => one(one(get(), 'focus'), 'values'), one(one(model, 'focus'), 'values'));
                    if (syntaxTokens(source, model.start, one(model, 'body').start).some(t => t.text === 'downto^')) await ui.structure(get(), 'direction');
                }
                await expression(() => one(get(), 'bound'), one(model, 'bound'));
                await statements(() => one(get(), 'body'), array(one(model, 'body'), 'items'));
            } else if (model.kind === 'enumdef') {
                await append('enumeration'); await unfold();
                await rename(one(get(), 'name'), text(one(model, 'name')));
                for (const [i, member] of array(model, 'members').entries()) {
                    if (i) await ui.addElement('enum', get(), 'members');
                    const current = () => array(get(), 'members')[i];
                    await rename(one(current(), 'name'), text(one(member, 'name')));
                    if (array(member, 'members').length) {
                        await ui.structure(current(), 'enum:explicit');
                        await expression(() => one(current(), 'members'), one(member, 'members'));
                    }
                }
            } else if (model.kind === 'with') {
                await append('with');
                const binding = () => one(get(), 'items'), original = one(model, 'items');
                await rename(one(binding(), 'targets'), text(one(original, 'targets')));
                await expression(() => one(binding(), 'values'), one(original, 'values'));
                await statements(() => one(get(), 'extra'), array(one(model, 'extra'), 'items'));
            } else throw Error(`Unsupported statement ${model.kind}: ${text(model)}`);
        }
    };
    return { statements, expression };
}

module.exports = { reconstruction };
