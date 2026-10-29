import type { AstNode, AstReply, SourceSpan } from "./protocol";
import type { StatementTemplate } from "./graphStatements";
import type { SourceEdit } from "./graphReorder";
import { syntaxTokens, templateMarker } from "./graphSyntax";
import { callInfo } from "./graphCalls";
import { assignmentValues } from "./graphAssignments";
import { patternLists, patternExpressions } from "./graphPatterns";
import { iteratorNames, forExpression, freshFocus } from "./graphLoops";

export interface ExpressionSite extends SourceSpan { kind: string; assignmentTarget?: boolean; memberKey?: boolean; errorName?: boolean; delegateName?: boolean;
    owner?: SourceSpan; callArguments?: string[]; spreadAllowed?: boolean; operand?: SourceSpan }
const kinds = new Set(["int", "float", "string", "bool", "nil", "ident", "hat-ident", "hole",
    "compare-chain", "import", "typeof", "type", "box", "spread", "scope", "name", "binary", "unary", "as", "call", "member", "index", "tuple", "table", "def", "self-table", "func", "interp", "if-expr", "try", "pack", "error-new", "require"]);

/** Declaration names, type syntax and member keys are not replaceable value expressions. */
export function expressionSites(tree: AstReply): ExpressionSite[] {
    const sites: ExpressionSite[] = [];
    const patterns = new Map(patternLists(tree).map(list => [list.condition, list.items]));
    const names = new Set<AstNode>();
    const collectNames = (node: AstNode) => {
        iteratorNames(node, tree.source).forEach(name => names.add(name));
        Object.values(node.fields ?? {}).flat().forEach(collectNames);
    };
    collectNames(tree.root);
    const visit = (node: AstNode, value = true, assignmentTarget = false, memberKey = false, spreadAllowed = false) => {
        if (names.has(node)) return;
        if (node.kind === "table-entry" && syntaxTokens(tree.source, node.start, node.end)[0]?.text === "delegate^") {
            const target = node.fields?.value;
            if (target && !Array.isArray(target)) sites.push({ kind: target.kind, start: target.start, end: target.end, delegateName: true });
            return;
        }

        const pattern = patterns.get(node);
        if (pattern && !pattern.includes(node)) { pattern.flatMap(patternExpressions).forEach(child => visit(child)); return; }
        if (["disabled", "module", "annotation", "import-stmt", "require-stmt"].includes(node.kind) || node.kind.startsWith("type-")) return;
        if (value && (kinds.has(node.kind) || forExpression(node, tree.source)) && node.start < node.end) {
            const info = callInfo({ kind: "call", start: node.start, end: node.end, line: node.line, column: node.column, fields: { target: node } });
            const operand = ["typeof", "box", "spread", "try", "pack", "unary"].includes(node.kind) && (node.fields?.operand ?? node.fields?.value);
            sites.push({ kind: node.kind, start: node.start, end: node.end,
                ...(operand && !Array.isArray(operand) ? { operand: { start: operand.start, end: operand.end } } : {}),
                ...(spreadAllowed && node.kind !== "spread" ? { spreadAllowed: true } : {}),
                ...(info ? { callArguments: info.inputs.map(input => input.default ?? (input.type === "number^" ? "0" : input.type === "string^" ? '\"\"' : input.type === "bool^" ? "false^" : "nil^")) } : {}),
                ...assignmentTarget ? { assignmentTarget: true } : {}, ...memberKey ? { memberKey: true } : {} });
        }
        if (node.kind === "import") return;
        if (["define", "reassign"].includes(node.kind)) {
            const values = node.kind === "reassign" ? assignmentValues(node, tree.source) : node.fields?.values, targets = node.fields?.targets;
            if (Array.isArray(values) && (values.length > 1 || values[0]?.kind === "tuple" && Array.isArray(targets) && targets.length > 1))
                sites.push({ kind: "initializers", start: values[0].start, end: values[values.length - 1].end,
                    owner: { start: node.start, end: node.end } });
        }
        for (const [field, children] of Object.entries(node.fields ?? {})) {
            if (node.kind === "reassign" && field === "values") {
                assignmentValues(node, tree.source).forEach(child => visit(child));
                continue;
            }
            if (node.kind === "error-new" && field === "name") {
                for (const child of Array.isArray(children) ? children : [children])
                    sites.push({ kind: child.kind, start: child.start, end: child.end, errorName: true });
                continue;
            }
            const declaration = ["name", "type", "return_type", "annotations"].includes(field) || node.kind === "compare-chain" && field === "operators"
                || field === "key" && !(node.kind === "table-entry" && node.computed)
                || node.kind === "define" && field === "targets"
                || node.kind === "func" && field === "params";
            for (const child of Array.isArray(children) ? children : [children]) {
                if (!declaration) visit(child, true, node.kind === "reassign" && field === "targets", node.kind === "member" && field === "argument" && !node.computed,
                    node.kind === "call" && ["argument", "args"].includes(field) && child === (Array.isArray(children) ? children[children.length - 1] : children));
                else if (["param", "field", "member-decl"].includes(child.kind)) visit(child, false);
            }
        }
    };
    visit(tree.root);
    return sites;
}

export const validMember = (text: string) => /^(?:[\p{L}_][\p{L}\p{N}_]*\^?|[0-9]+)$/u.test(text);
export const validReference = (text: string) => text === "..." || /^(?:(?:\$+|\$\^+)?[\p{L}_][\p{L}\p{N}_]*|self\^|it\^)(?:\.(?:[\p{L}_][\p{L}\p{N}_]*\^?|[0-9]+))*$/u.test(text);
export const validExpressionReference = (site: ExpressionSite, text: string) => site.delegateName
    ? /^(?:self\^\.)?[\p{L}_][\p{L}\p{N}_]*$/u.test(text)
    : site.errorName
    ? /^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(text)
    : (site.memberKey ? validMember : validReference)(text);

/** Grouping has no AST node. A binary span may start inside a grouped left operand. */
export function replacementSpan(tree: AstReply, site: SourceSpan): SourceSpan | undefined {
    const source = tree.source;
    let start = templateMarker(source, site)?.start ?? site.start, end = site.end, opens = 0, closes = 0;
    for (const token of syntaxTokens(source, start, end)) {
        if (token.text === "(") opens++;
        else if (token.text === ")") { if (opens) opens--; else closes++; }
    }
    let lower = 0, upper = source.length;
    if (opens || closes) {
        const visit = (node: AstNode) => {
            if (node.kind === "interp-hole" && node.start <= site.start && node.end >= site.end) {
                lower = node.start + 1; upper = node.end - 1;
            }
            Object.values(node.fields ?? {}).flat().filter(child => child.start <= site.start && child.end >= site.end).forEach(visit);
        };
        visit(tree.root);
    }
    while (closes-- > 0) {
        const previous = syntaxTokens(source, lower, start).slice(-1)[0];
        if (previous?.text !== "(") return undefined;
        start = previous.start;
    }
    while (opens-- > 0) {
        const next = syntaxTokens(source, end, upper)[0];
        if (next?.text !== ")") return undefined;
        end = next.end;
    }
    return { start, end };
}

export function expressionTemplates(tree: AstReply, site: ExpressionSite): StatementTemplate[] {
    const currentSite = expressionSites(tree).find(s => s.kind === site.kind && s.start === site.start && s.end === site.end);
    if (!currentSite) return [];
    const span = replacementSpan(tree, site);
    if (!span) return [];
    const valueSpan = currentSite.kind === "spread" && currentSite.operand ? replacementSpan(tree, currentSite.operand) : span;
    if (!valueSpan) return [];
    const current = tree.source.slice(valueSpan.start, valueSpan.end);
    const choices: [string, string, string][] = [
        ["match", "Pattern matching expression", "(for^nil^: when^0: 0 other^: 0;)"],
        ["number", "Number", "0"], ["string", "String", '""'], ["true", "True", "true^"],
        ["false", "False", "false^"], ["nil", "Nil", "nil^"], ["table", "Table", "{}"],
        ["tuple", "Tuple", "(0, 0)"],
        ["function", "Function", "f^{ return^ 0 }"], ["procedure", "Procedure", "p^{}"],
        ["definition", "Table definition", "def^{}"],
        ["selfTable", "Self table", "self^{}"],
        ["local", "Expression with a local value", `(for^let^${freshFocus(tree.source)} = 0 do^: (${current});)`],
        ["conditional", "Conditional expression", "(if^true^: 0 el^: 0;)"],
        ["interpolation", "Interpolated string", '$"text{0}"'],
        ["try", "Propagate an error", `try^(${current})`],
        ["pack", "Pack return values", `pack^(${current})`],
        ["typeof", "Get the type of this value", `typeof^(${current})`],
        ["box", "Box this value", `box^(${current})`],
        ["constbox", "Make a constant box", `constbox^(${current})`],
        ["typeValue", "Type value", "number^"],
        ["name", "Identifier value", "id^name"],
        ["error", "Error value", "error^Problem.Failure{}"],
        ["import", "Import module", "import^std.io"],
        ["require", "Require file", 'require^"./module.lh"'],
        ["member", "Access a member", `(${current}).value`],
        ["call", "Call this value", `(${current})(${(currentSite.callArguments ?? ["nil^"]).join(", ")})`],
        ["index", "Index this value", `(${current})[0]`],
        ["add", "Add to this value", `((${current}) + 0)`],
        ["fits", "Check type compatibility", `((${current}) fits^ number^)`],
        ["cast", "Convert to a type", `((${current}) as^ number^)`],
        ["chain", "Chained comparisons", `((${current}) < 0 < 0)`],
        ["compare", "Compare values", `((${current}) = 0)`],
        ["logical", "Combine conditions", `((${current}) and^ true^)`],
        ["fallback", "Default a missing value", `((${current}) ?? nil^)`],
        ["bitwise", "Bitwise expression", `((${current}) bitand^ 0)`],
        ["product", "Vector product", `((${current}) dot^ 0)`],
        ["not", "Negate condition", `(!(${current}))`],
        ["present", "Check for a non-nil value", `((${current})?)`],
        ["negative", "Negate number", `(-(${current}))`],
    ];
    if (currentSite.spreadAllowed) choices.push(["spread", "Expand trailing argument", `(${current})...`]);
    if (currentSite.operand) {
        const operand = replacementSpan(tree, currentSite.operand);
        if (operand) choices.push(["unwrap", "Use the inner value", `(${tree.source.slice(operand.start, operand.end)})`]);
    }
    if (/^(?:\$+|\$\^+)?[\p{L}_][\p{L}\p{N}_]*$/u.test(current)) {
        const name = current.replace(/^\$(?:\^+|\$*)/, "");
        choices.push(["scope:file", "Reference the unit scope", `$${name}`], ["scope:outer", "Reference the enclosing scope", `$^${name}`]);
    }
    const references = new Set<string>(currentSite.errorName ? ["Problem.Failure"] : currentSite.delegateName ? ["value", "self^.value"] : currentSite.memberKey ? ["value", "0"] : ["self^", "it^"]);
    const names = (node: AstNode) => {
        if (["ident", "hat-ident", "member", "scope"].includes(node.kind)) {
            const name = tree.source.slice(node.start, node.end);
            if (validExpressionReference(currentSite, name)) references.add(name);
        }
        for (const child of Object.values(node.fields ?? {}).flat()) names(child);
    };
    names(tree.root);
    return [...choices.filter(([id]) => !currentSite.errorName && !currentSite.delegateName && !currentSite.memberKey && (!currentSite.assignmentTarget || ["index", "member"].includes(id))).map(([id, label, text]) => ({ id, label, text })),
        ...[...references].sort().map(name => ({ id: `reference:${name}`, label: name, text: name }))];
}

export function replaceExpression(tree: AstReply, site: ExpressionSite, template: string): SourceEdit | undefined {
    const choices = expressionTemplates(tree, site);
    if (!choices.length) return undefined;
    const name = template.startsWith("reference:") ? template.slice(10) : undefined;
    const currentSite = expressionSites(tree).find(s => s.kind === site.kind && s.start === site.start && s.end === site.end)!;
    const text = name !== undefined && validExpressionReference(currentSite, name) ? name : choices.find(c => c.id === template)?.text;
    const span = replacementSpan(tree, currentSite);
    // Bare ellipsis after return^ is parsed as a separate statement.
    return text === undefined || !span ? undefined : { ...span, text: text === "..." ? "(...)" : text };
}
