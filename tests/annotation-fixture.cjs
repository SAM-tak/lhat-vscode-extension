const source = '@unit\nmodule^"demo"\n@range(0, 100, "a,b")\n@label("日本語😀")\nlet^ value = 1';
const n = (kind, start, end, fields) => ({ kind, start, end, line: source.slice(0, start).split('\n').length, column: 1, fields });
const start = source.indexOf('let^');
const value = n('define', start, source.length, { targets: [n('ident', source.indexOf('value'), source.indexOf('value') + 5)], values: [n('int', source.length - 1, source.length)] });
module.exports = () => ({ source, root: n('block', 0, source.length, { items: [n('module', source.indexOf('module^'), source.indexOf('\n@range')), value] }) });
