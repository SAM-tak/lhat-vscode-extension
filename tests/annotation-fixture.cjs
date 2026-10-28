const original = '@unit\nmodule^"demo"\n@range(0, 100, "a,b")\n@label("日本語😀")\nlet^ value = 1';
module.exports = (source = original) => {
    const n = (kind, start, end, fields) => ({ kind, start, end, line: source.slice(0, start).split('\n').length, column: 1, fields });
    const letStart = source.indexOf('let^'), publicStart = source.lastIndexOf('public^', letStart);
    const start = publicStart >= 0 && !source.slice(publicStart + 7, letStart).trim() ? publicStart : letStart;
    const value = n('define', start, source.length, { targets: [n('ident', source.indexOf('value'), source.indexOf('value') + 5)], values: [n('int', source.length - 1, source.length)] });
    return { source, root: n('block', 0, source.length, { items: [n('module', source.indexOf('module^'), source.indexOf('\n', source.indexOf('module^'))), value] }),
        annotationChoices: [
            { name: 'unit', targets: { unit: true }, parameterTypes: [] },
            { name: 'unit_kind', targets: { unit: true }, parameterTypes: ['string^'] },
            { name: 'range', targets: { binding: true }, parameterTypes: ['number^', 'number^', 'string^'] },
            { name: 'label', targets: { binding: true }, parameterTypes: ['string^'] },
            { name: 'game', targets: { binding: true }, parameterTypes: [] },
            { name: 'export_class', targets: { binding: true }, parameterTypes: [] },
            { name: 'export_range', targets: { binding: true }, parameterTypes: ['number^', 'number^'] },
        ] };
};
