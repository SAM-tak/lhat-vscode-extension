const fs = require('node:fs');
const path = require('node:path');

function languageCases() {
    const cases = [];
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (file.endsWith('.lh')) cases.push({ name: path.relative(path.resolve(__dirname, '..'), file), source: fs.readFileSync(file, 'utf8') });
        }
    };
    walk(path.resolve(__dirname, '../testing'));
    cases.push(
        { name: 'values', source: 'let^boxed=box^nil^ let^sealed=constbox^boxed let^name=id^thing let^outer=$boxed let^kind=typeof^(0) let^descriptor=type^<number^> let^cast=0 as^number^ print((1,2)...) let^module=import^std.math' },
        { name: 'procedure', source: 'let^run=p^{yield^0 await^nil^}' },
        { name: 'coroutine', source: 'let^f=f^arg:c^{f^number^ ->string^ ->bool^}{0}' },
        { name: 'intersection', source: 'let^f=f^arg:(t^{}&t^{}){0}' },
        { name: 'chain-next', source: 'let^value=0<1<2 repeat^2{next^}' },
        { name: 'callable-tuple-type', source: 'let^f=f^arg:(f^number^ ->(number^,string^);){0}' },
        { name: 'callable-modifiers', source: 'let^factory=template^f^value:number^ ->fresh^t^{}{return^{}} let^Item=def^{method=f^mutable^self^{return^def^}}' },
        { name: 'position-types', source: 'let^f=f^arg:t^{number^[3],[string^]:any^,self^{field:number^}}{0}' },
        { name: 'handlers', source: 'errordef^Problem{First,Second} if^true^{try^work() catch^Problem.First|Problem.Second: print(1) catch^: finally^:print(2)}' },
        { name: 'cleanup-transfer', source: 'let^run=p^{do^{if^true^{return^} work() catch^:handle() finally^:cleanup()} after()}' },
        { name: 'recovery', source: 'let^value=)', recovery: true },
        { name: 'annotation', source: '@game let^value=0' },
    );
    return cases.map(item => ({ ...item, source: item.source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') }));
}

function declaredKinds() {
    const source = fs.readFileSync(path.resolve(__dirname, '../../lhat/src/ast.c'), 'utf8');
    return [...source.matchAll(/case LHAT_NODE_[^:]+:\s*return "([^"]+)"/g)].map(match => match[1]);
}

module.exports = { languageCases, declaredKinds };
