import type { AstNode, AstReply, SourceSpan } from "./protocol";
import type { SourceEdit } from "./graphReorder";
import type { StatementInsertion, StatementTemplate } from "./graphStatements";
import { resultTypes, syntaxTokens } from "./graphSyntax";
import { callInfo, canInsertBinding } from "./graphCalls";

export interface ListInsertion extends StatementInsertion { category: "list" }
export type InsertionSite = StatementInsertion | ListInsertion;
export const isListInsertion = (site: InsertionSite): site is ListInsertion => "category" in site;
export interface CommaList {
    node: AstNode; field: string; items: AstNode[];
    start: number; end: number; mode: "value" | "member" | "parameter" | "type" | "name" | "enum" | "error";
    /** No written result yet: an edit must materialize its inferred slots first. */
    implicit?: string[];
    /** Empty optional braces which must be written when the first item is added. */
    materialize?: { prefix: string; suffix: string };
}
const array = (value: AstNode | AstNode[] | undefined): AstNode[] => value ? Array.isArray(value) ? value : [value] : [];
const one = (node: AstNode, field: string) => array(node.fields?.[field])[0];
export const listIdentity = (node: SourceSpan & { kind: string }, field: string) => `${node.kind}:${node.start}:${node.end}:${field}`;

/** All source comma lists use the same insertion model, including empty lists. */
export function commaLists(tree: AstReply): CommaList[] {
    const result: CommaList[] = [], source = tree.source;
    const visit = (node: AstNode) => {
        if (node.kind === "disabled") return;
        const tokens = syntaxTokens(source, node.start, node.end);
        const add = (field: string, mode: CommaList["mode"], start: number, end: number,
            items = array(node.fields?.[field]), implicit?: string[], materialize?: CommaList["materialize"]) => {
            if (start <= end) result.push({ node, field, items, mode, start, end, implicit, materialize });
        };
        const braced = ["table", "def", "self-table", "type-table", "enumdef", "errordef", "error-kind", "error-new"];
        if (braced.includes(node.kind)) {
            const field = ["enumdef", "errordef", "error-kind", "error-new"].includes(node.kind) ? "members" : "items";
            const open = tokens.find(t => t.text === "{"), close = tokens.slice(-1)[0];
            if (open && close?.text === "}") add(field, node.kind === "type-table" ? "type"
                : node.kind === "enumdef" ? "enum" : node.kind === "errordef" ? "error"
                : node.kind === "error-kind" ? "parameter" : "member", open.end, close.start);
            else if (node.kind === "error-kind") add("members", "parameter", node.end, node.end, [], undefined,
                { prefix: " { ", suffix: " }" });
        } else if (["call", "index", "tuple", "type-tuple"].includes(node.kind)) {
            const target = one(node, "target"), opening = node.kind === "index" ? "[" : "(";
            const open = tokens.find(t => t.start >= (target?.end ?? node.start) && t.text === opening);
            const close = tokens.slice(-1)[0];
            if (open && close?.text === (opening === "[" ? "]" : ")")) add(target ? "argument" : "items",
                node.kind === "type-tuple" ? "type" : "value", open.end, close.start);
        } else if (["return", "yield"].includes(node.kind)) {
            // A parser-generated implicit return has no keyword, but its values still form a list.
            const marker = tokens[0]?.text === `${node.kind}^` ? tokens[0].end : node.start;
            add("value", "value", marker, node.end);
        } else if (["define", "reassign"].includes(node.kind)) {
            const targets = array(node.fields?.targets), values = array(node.fields?.values);
            const equal = tokens.find(t => ["=", ":="].includes(t.text) && t.start >= (targets.slice(-1)[0]?.end ?? node.start));
            if (targets.length) add("targets", node.kind === "define" ? "parameter" : "name", targets[0].start, equal?.start ?? node.end);
            if (equal) add("values", "value", equal.end, node.end, values);
        } else if (["func", "type-func"].includes(node.kind)) {
            const body = one(node, "body"), annotation = one(node, "return_type");
            const marker = tokens.find(t => ["f^", "p^"].includes(t.text));
            const end = body?.start ?? (tokens.slice(-1)[0]?.text === ";" ? tokens.slice(-1)[0].start : node.end);
            const arrow = tokens.find(t => t.text === "->" && t.end <= (annotation?.start ?? end) && t.start >= (array(node.fields?.params).slice(-1)[0]?.end ?? marker?.end ?? node.start));
            if (marker) add("params", node.kind === "func" ? "parameter" : "type", marker.end, arrow?.start ?? end);
            const items = annotation?.kind === "type-tuple" ? array(annotation.fields?.items) : annotation ? [annotation] : [];
            add("return_type", "type", annotation?.start ?? end, annotation?.end ?? end, items,
                annotation ? undefined : node.inferredReturnType ? resultTypes(node.inferredReturnType) : marker?.text === "f^" ? ["?"] : []);
        } else if (node.kind === "for") {
            for (const field of ["focus", "advance"]) {
                const items = array(node.fields?.[field]);
                if (items.length) add(field, "value", items[0].start, items[items.length - 1].end, items);
            }
        }
        for (const child of Object.values(node.fields ?? {}).flat()) visit(child);
    };
    visit(tree.root);
    // A function's return tuple is already represented by its signature list.
    return result.filter(list => list.node.kind !== "type-tuple" || !result.some(parent => parent.field === "return_type" &&
        one(parent.node, "return_type") === list.node));
}

export function listInsertions(tree: AstReply): ListInsertion[] {
    const lists = commaLists(tree);
    return lists.flatMap((list) => {
        const { node, field, items, implicit } = list;
        const base: ListInsertion = { category: "list", kind: node.kind, start: node.start, end: node.end, field };
        return [...(implicit ? implicit.slice(1).map((_, i) => ({ ...base, before: -(i + 2) }))
            : items.slice(1).map(item => ({ ...base, before: item.start }))), base].filter(site => editableList(list, site, lists));
    });
}

function editableList(list: CommaList, site: ListInsertion, lists: CommaList[]): boolean {
    if (list.node.kind === "define") return list.field === "targets" && canInsertBinding(list.node);
    if (list.node.kind === "tuple" && lists.some(parent => parent.node.kind === "define" && parent.field === "values" &&
        parent.items.length === 1 && parent.items[0] === list.node && array(parent.node.fields?.targets).length > 1)) return false;
    if (list.node.kind === "call" && list.field === "argument") {
        const info = callInfo(list.node);
        if (!info) return false;
        const index = site.before === undefined ? list.items.length : list.items.findIndex(item => item.start === site.before);
        return index >= info.inputs.length ? info.variadic !== undefined
            : index === list.items.length && list.items.length < info.inputs.length;
    }
    return true;
}

function findList(tree: AstReply, site: ListInsertion): CommaList | undefined {
    const lists = commaLists(tree);
    return lists.find(list => listIdentity(list.node, list.field) === listIdentity(site, site.field) &&
        (site.before === undefined || list.items.slice(1).some(item => item.start === site.before) ||
            (list.implicit && site.before <= -2 && -site.before <= list.implicit.length)) && editableList(list, site, lists));
}

export const LIST_TEMPLATE_LABELS = {
    number: "Number", string: "Text", boolean: "Boolean", nil: "Nil", table: "Table literal",
    function: "Function", procedure: "Procedure", member: "Named member", parameter: "Parameter",
    typeMember: "Typed member", name: "Variable", enum: "Enumeration member", error: "Error kind", any: "Any type",
    binding: "Variable binding", default: "Default argument",
} as const;

export function listTemplates(tree: AstReply, site: ListInsertion): StatementTemplate[] {
    const list = findList(tree, site);
    if (!list) return [];
    const used = new Set(syntaxTokens(tree.source).map(t => t.text));
    const name = (base: string) => { let next = base, i = 2; while (used.has(next)) next = `${base}${i++}`; return next; };
    const choice = (id: keyof typeof LIST_TEMPLATE_LABELS, text: string): StatementTemplate => ({ id, label: LIST_TEMPLATE_LABELS[id], text });
    if (list.node.kind === "define") return [choice("binding", "_^ = nil^")];
    if (list.node.kind === "call") {
        const info = callInfo(list.node);
        const index = site.before === undefined ? list.items.length : list.items.findIndex(item => item.start === site.before);
        const input = info?.inputs[index] ?? info?.variadic;
        if (input?.default !== undefined) return [choice("default", input.default)];
        const initial = input?.type === "number^" ? "0" : input?.type === "string^" ? '""'
            : input?.type === "bool^" ? "false^" : "nil^";
        return [choice("default", initial)];
    }
    if (list.mode === "parameter") return [choice("parameter", `${name("value")}: any^`)];
    if (list.mode === "name") return [choice("name", name("value"))];
    if (list.mode === "enum") return [choice("enum", name("Item"))];
    if (list.mode === "error") return [choice("error", `${name("Problem")} {}`)];
    if (list.mode === "type") {
        const types = [choice("number", "number^"), choice("string", "string^"), choice("boolean", "bool^"), choice("any", "any^")];
        return list.node.kind === "type-table" ? [choice("typeMember", `${name("value")}: number^`), ...types] : types;
    }
    const values = [choice("number", "0"), choice("string", '""'), choice("boolean", "false^"), choice("nil", "nil^"),
        choice("table", "{}"), choice("function", "f^{ return^ 0 }"), choice("procedure", "p^{}")];
    if (list.mode === "member") {
        const member = choice("member", `${name("value")} = 0`);
        if (["def", "self-table", "error-new"].includes(list.node.kind)) return [member];
        values.unshift(member);
    }
    return values;
}

/** Insert at a syntax-owned comma, retaining grouping, comments and trailing commas. */
export function insertListEdit(tree: AstReply, site: ListInsertion, template: string): SourceEdit | undefined {
    const choice = listTemplates(tree, site).find(t => t.id === template);
    if (!choice) return undefined;
    const list = findList(tree, site)!;
    if (list.node.kind === "define") {
        const lists = commaLists(tree);
        let values = lists.find(other => other.node === list.node && other.field === "values");
        if (list.items.length > 1 && values?.items.length === 1 && values.items[0].kind === "tuple") {
            values = lists.find(other => other.node === values!.items[0] && other.field === "items");
        }
        if (!values) return undefined;
        const index = site.before === undefined ? list.items.length : list.items.findIndex(item => item.start === site.before);
        const edits = [insertAt(tree.source, list, index, "_^"), insertAt(tree.source, values, index, "nil^")];
        let text = tree.source.slice(list.node.start, list.node.end);
        for (const edit of edits.sort((a, b) => b.start - a.start)) {
            text = text.slice(0, edit.start - list.node.start) + edit.text + text.slice(edit.end - list.node.start);
        }
        return { start: list.node.start, end: list.node.end, text };
    }
    if (list.implicit) {
        const types = list.implicit.map(t => t === "?" ? "any^" : t);
        types.splice(site.before === undefined ? types.length : -site.before - 1, 0, choice.text);
        return { start: list.start, end: list.start, text: ` -> ${types.join(", ")} ` };
    }
    const tokens = syntaxTokens(tree.source, list.start, list.end);
    if (!list.items.length) return { start: list.start, end: list.start,
        text: list.materialize ? `${list.materialize.prefix}${choice.text}${list.materialize.suffix}`
            : `${["params", "value"].includes(list.field) ? " " : ""}${choice.text}${list.field === "params" ? " " : ""}` };
    const index = list.items.findIndex(item => item.start === site.before);
    if (index > 0) {
        const comma = tokens.find(t => t.text === "," && t.start >= list.items[index - 1].end && t.end <= list.items[index].start);
        if (!comma) return undefined;
        return { start: comma.end, end: comma.end, text: ` ${choice.text},` };
    }
    const last = tokens[tokens.length - 1];
    const end = last?.text === "," ? last.start : last?.end ?? list.end;
    return { start: end, end, text: `, ${choice.text}` };
}

function insertAt(source: string, list: CommaList, index: number, text: string): SourceEdit {
    const tokens = syntaxTokens(source, list.start, list.end);
    const next = list.items[index];
    if (next) {
        const comma = tokens.find(token => token.text === "," && token.start >= list.items[index - 1].end && token.end <= next.start)!;
        return { start: comma.end, end: comma.end, text: ` ${text},` };
    }
    const last = tokens[tokens.length - 1], at = last?.text === "," ? last.start : last?.end ?? list.end;
    return { start: at, end: at, text: `, ${text}` };
}

export interface OperatorSite extends SourceSpan { owner: SourceSpan; text: string; choices: string[]; members?: SourceSpan[] }
const numeric = ["+", "-", "*", "/", "//", "%", "**"];
const comparison = ["==", "!=", "<", "<=", ">", ">="];
export function operatorSites(tree: AstReply): OperatorSite[] {
    const sites: OperatorSite[] = [];
    const visit = (node: AstNode) => {
        if (node.kind === "disabled") return;
        const left = one(node, "left"), right = one(node, "right");
        const operands = array(node.fields?.operands);
        const pairs = left && right && node.kind === "binary" ? [[left, right]] : operands.slice(1).map((r, i) => [operands[i], r]);
        for (const [a, b] of pairs) {
            const token = syntaxTokens(tree.source, a.end, b.start).find(t => !["(", ")"].includes(t.text));
            if (!token) continue;
            const choices = numeric.includes(token.text) ? numeric : comparison.includes(token.text) ? comparison
                : ["and^", "or^"].includes(token.text) ? ["and^", "or^"] : [token.text];
            sites.push({ ...token, owner: { start: node.start, end: node.end }, choices });
        }
        Object.values(node.fields ?? {}).flat().forEach(visit);
    };
    visit(tree.root);
    return sites;
}

export function replaceOperatorEdit(tree: AstReply, span: SourceSpan, operator: string): SourceEdit | undefined {
    const site = groupedOperatorSites(tree).find(s => s.start === span.start && s.end === span.end);
    if (!site || !site.choices.includes(operator)) return undefined;
    const members = site.members ?? [site], start = Math.min(...members.map(s => s.start)), end = Math.max(...members.map(s => s.end));
    let text = tree.source.slice(start, end);
    for (const member of [...members].sort((a, b) => b.start - a.start)) {
        text = text.slice(0, member.start - start) + operator + text.slice(member.end - start);
    }
    return { start, end, text };
}

/** Fold only the existing association spine, and never cross written parentheses. */
export function operatorGroup(node: AstNode, source: string, sites: OperatorSite[]): { operands: AstNode[]; site?: OperatorSite } {
    const own = sites.find(site => site.owner.start === node.start && site.owner.end === node.end);
    const left = one(node, "left"), right = one(node, "right");
    if (!own || !left || !right) return { operands: [left, right].filter((n): n is AstNode => !!n), site: own };
    const primitive = (n: AstNode) => ["number^", "string^", "bool^"].includes(n.inferredType ?? "");
    const rightAssociative = ["**", ".."].includes(own.text);
    const nested = rightAssociative ? right : left;
    const nestedOp = sites.find(site => site.owner.start === nested.start && site.owner.end === nested.end);
    const outside = rightAssociative ? source.slice(own.end, nested.start) + source.slice(nested.end, node.end)
        : source.slice(node.start, nested.start) + source.slice(nested.end, own.start);
    const parentheses = syntaxTokens(source, nested.start, nested.end)[0]?.text === "(" || /[()]/.test(syntaxTokens(outside).map(t => t.text).join(""));
    if (nested.kind !== "binary" || nestedOp?.text !== own.text || parentheses ||
        !primitive(node) || !primitive(left) || !primitive(right) || ![...numeric, ".."].includes(own.text)) return { operands: [left, right], site: own };
    const group = operatorGroup(nested, source, sites);
    if (!group.operands.every(primitive)) return { operands: [left, right], site: own };
    const members = [...group.site?.members ?? [nestedOp], own];
    return { operands: rightAssociative ? [left, ...group.operands] : [...group.operands, right], site: { ...own, members } };
}

export function groupedOperatorSites(tree: AstReply): OperatorSite[] {
    const all = operatorSites(tree), result: OperatorSite[] = [];
    const visit = (node: AstNode) => {
        if (node.kind === "disabled") return;
        if (node.kind === "binary") {
            const group = operatorGroup(node, tree.source, all);
            if (group.site) result.push(group.site);
            group.operands.forEach(visit);
        } else {
            result.push(...all.filter(site => site.owner.start === node.start && site.owner.end === node.end));
            Object.values(node.fields ?? {}).flat().forEach(visit);
        }
    };
    visit(tree.root);
    return result;
}
