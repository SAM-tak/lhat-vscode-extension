import { accessOperator } from "./graphCalls";
import { replacementSpan, validReference } from "./graphExpressions";
import { commaLists, insertListEdit, listTemplates, removeListElement, comparison } from "./graphLists";
import type { AstNode, AstReply, SourceSpan } from "./protocol";
import type { SourceEdit } from "./graphReorder";
import type { StatementTemplate } from "./graphStatements";
import { syntaxTokens, templateMarker, resultTypes } from "./graphSyntax";
import { literalOf, quoteString, isNumberLiteral } from "./webview/literals";
import { assignmentOperator, ASSIGNMENT_LABELS } from "./graphAssignments";
import { typeSites, freshMarker, isTypeNode } from "./graphTypes";
import { iteratorNames, freshFocus, forExpression } from "./graphLoops";
import { handlerActions, validCatchFilter } from "./graphHandlers";
import { validName, validMemberName, nameSegments, quoteName, nameValue, sourceNames, sameName } from "./graphNames";

export function validTypeReference(text: string): boolean {
    const path = nameSegments(text);
    return !!path && !["f^", "p^"].includes(path[0]) &&
        (validMemberName(path[0]) || /^Self\^+$/.test(path[0])) && path.slice(1).every(validMemberName);
}

export function validStructureInput(input: NonNullable<StatementTemplate["input"]>, value: string): boolean {
    if (input.kind === "declarationPath") {
        if (value === "_^") return true;
        const scope = /^\$(?:\^+|\$*)/.exec(value)?.[0];
        const path = nameSegments(scope ? value.slice(scope.length) : value);
        return !!path && validReference(value) && !!(scope || validName(path[0]) || path[0] === "L^" && path.length > 1) && path.slice(1).every(validMemberName);
    }
    if (input.kind === "catchType") return validCatchFilter(value);
    if (input.kind === "typeName") return validTypeReference(value);
    if (input.kind !== "count") return validMemberName(value);
    if (!/^[0-9]/.test(value) || !isNumberLiteral(value)) return false;
    try { const count = BigInt(value.replace(/_/g, "")); return count > 0n && count <= 256n; } catch { return false; }
}

export interface StructureSite extends SourceSpan { kind: string }
interface Action extends StatementTemplate { edit: SourceEdit }
const array = (value: AstNode | AstNode[] | undefined): AstNode[] => value ? Array.isArray(value) ? value : [value] : [];
const one = (node: AstNode, field: string) => array(node.fields?.[field])[0];
function receiverMutation(param: AstNode, source: string) {
    const receiver = one(param, "name") ?? one(param, "type");
    if (!receiver || source.slice(receiver.start, receiver.end) !== "self^") return undefined;
    const marker = syntaxTokens(source, param.start, receiver.start).find(token => token.text === "mutable^");
    return { label: marker ? "Use an immutable receiver" : "Use a mutable receiver", edit: marker
        ? { start: marker.start, end: marker.end, text: "" } : { start: param.start, end: param.start, text: "mutable^" } };
}

function freshness(node: AstNode, source: string) {
    const annotation = one(node, "return_type"), marker = freshMarker(node, source), body = one(node, "body");
    if (marker) return { label: "Remove fresh result promise", edit: { start: marker.start, end: marker.end, text: "" } };
    if (annotation?.kind === "type-tuple") return undefined;
    const inferred = resultTypes(node.inferredReturnType);
    if (!annotation && (!body || !node.inferredReturnType || inferred.length !== 1)) return undefined;
    const parameters = array(node.fields?.params), at = parameters[parameters.length - 1]?.end ?? node.start;
    const arrow = syntaxTokens(source, at, annotation?.start ?? body?.start ?? node.end).find(token => token.text === "->");
    return arrow ? { label: "Promise a fresh result", edit: { start: arrow.end, end: arrow.end, text: " fresh^" } }
        : body ? { label: "Promise a fresh result", edit: { start: body.start, end: body.start, text: ` -> fresh^${inferred[0] === "?" ? "any^" : inferred[0]} ` } } : undefined;
}

export function structureSites(tree: AstReply): StructureSite[] {
    const sites: StructureSite[] = [];
    const visit = (node: AstNode, parent?: AstNode) => {
        if (node.kind === "disabled") return;
        if ((["block", "if-clause"].includes(node.kind) && handlerActions(tree, node, parent).length) || node.kind.startsWith("type-") || ["with", "if-stmt", "if-expr", "repeat", "for", "define", "reassign", "enumdef", "errordef", "table-entry", "enum-member", "return", "break", "next", "param", "string", "scope", "box", "member", "index", "call", "compare-chain", "binary", "func"].includes(node.kind))
            sites.push({ start: node.start, end: node.end, kind: node.kind });
        Object.values(node.fields ?? {}).flat().forEach(child => visit(child, node));
    };
    visit(tree.root); return sites;
}

function actions(tree: AstReply, site: StructureSite): Action[] {
    let node: AstNode | undefined, parent: AstNode | undefined, callable: AstNode | undefined;
    let loops = 0;
    const find = (candidate: AstNode, owner?: AstNode, enclosing?: AstNode, depth = 0) => {
        if (candidate.kind === "disabled") return;
        if (candidate.kind === "func") depth = 0;
        if (candidate.kind === "repeat" || candidate.kind === "for" && one(candidate, "body")?.kind === "block" && !forExpression(candidate, tree.source)) depth++;
        if (candidate.kind === site.kind && candidate.start === site.start && candidate.end === site.end) { node = candidate; parent = owner; callable = enclosing; loops = depth; }
        Object.values(candidate.fields ?? {}).flat().forEach(child => find(child, candidate, candidate.kind === "func" ? candidate : enclosing, depth));
    };
    find(tree.root);
    if (!node) return [];
    const source = tree.source, result: Action[] = [], newline = source.includes("\r\n") ? "\r\n" : "\n";
    const add = (id: string, label: string, edit: SourceEdit, preview = edit.text || label) => result.push({ id, label, text: preview, edit });
    const head = syntaxTokens(source, node.start, node.end);
    if (["break", "next"].includes(node.kind)) {
        for (let level = 1; level <= loops; level++) for (const [word, label] of [["break", "Exit loop"], ["next", "Next iteration"]])
            add(`jump:${word}:${level}`, label, { start: node.start, end: node.end, text: word + "^".repeat(level) });
        return result;
    }
    result.push(...handlerActions(tree, node, parent));
    if (parent?.kind === "table-entry" && syntaxTokens(source, parent.start, parent.end)[0]?.text === "delegate^") return [];
    const access = !isTypeNode(node) && accessOperator(node, source);
    if (access) add("access:nil-check", access.optional ? "Use ordinary access" : "Use nil-checked access", access.optional
        ? { start: access.optional.start, end: access.optional.end, text: "" }
        : { start: access.delimiter.start, end: access.delimiter.start, text: "?" });
    const left = one(node, "left"), right = one(node, "right");
    const op = left && right && syntaxTokens(source, left.end, right.start).find(t => !["(", ")"].includes(t.text))?.text;
    if (node.kind === "compare-chain" || node.kind === "binary" && (comparison.includes(op || "") || op === "fits^")) {
        const span = replacementSpan(tree, node);
        if (span) {
            add("chain:append", "Add a comparison", { start: span.end, end: span.end, text: " < 0" });
            const operators = array(node.fields?.operators), last = operators[operators.length - 1];
            if (last) {
                let gap = source.slice(last.start, span.end);
                for (const token of syntaxTokens(source, last.start, span.end).reverse())
                    gap = gap.slice(0, token.start - last.start) + gap.slice(token.end - last.start);
                add("chain:remove-last", "Remove last comparison", { start: last.start, end: span.end, text: gap });
            }
        }
        return result;
    }
    if (node.kind === "scope") {
        const name = one(node, "name");
        if (!name) return [];
        const prefix = source.slice(node.start, name.start), relative = prefix.startsWith("$^");
        for (const [id, label, text] of [["file", "Reference the unit scope", "$"], ["outer", "Reference the enclosing scope", "$^"],
            ["more", relative ? "Look one more scope outward" : "Look one more scope inward", prefix + (relative ? "^" : "$")]])
            add(`scope:${id}`, label, { start: node.start, end: name.start, text });
        if (prefix.length > (relative ? 2 : 1)) add("scope:less", "Reduce scope distance", { start: node.start, end: name.start, text: prefix.slice(0, -1) });
        return result;
    }
    if (node.kind === "box") {
        const marker = head[0];
        if (marker) add("box:toggle", marker.text === "constbox^" ? "Use a mutable box" : "Make a constant box", {
            start: marker.start, end: marker.end, text: marker.text === "constbox^" ? "box^" : "constbox^" });
        return result;
    }
    if (node.kind === "for") {
        add("focus:wrap", "Add an outer local value", { start: node.start, end: node.start, text: `for^let^${freshFocus(source)} = 0 ` });
        const body = one(node, "body");
        if (body?.kind === "for") add("focus:unwrap", "Remove the outer local scope", { start: node.start, end: body.start, text: "" });
    }

    if (node.kind === "func") {
        const marker = templateMarker(source, node);
        add("function:template", marker ? "Use an ordinary callable" : "Use a callable template", marker
            ? { start: marker.start, end: marker.end, text: "" } : { start: node.start, end: node.start, text: "template^" });
        const fresh = freshness(node, source);
        if (fresh) add("function:fresh", fresh.label, fresh.edit);
        return result;
    }
    if (isTypeNode(node)) {
        const names = new Set(["number^", "string^", "bool^", "nil^", "any^", "t^{}"]);
        const owner = typeSites(tree).find(site => site.annotation && site.annotation.start <= node!.start && site.annotation.end >= node!.end);
        const removeName = (name: string) => { for (const candidate of names) if (sameName(candidate, name)) names.delete(candidate); };
        const collect = (scope: AstNode) => {
            if (scope.kind === "def") names.add("Self^");
            if (scope.kind === "block") for (const declaration of array(scope.fields?.items)) {
                if (["enumdef", "errordef"].includes(declaration.kind)) {
                    const name = one(declaration, "name");
                    if (name) { const text = source.slice(name.start, name.end); removeName(text); names.add(text); }
                }
                if (declaration.kind === "define") array(declaration.fields?.targets).forEach((target, index) => {
                    const value = array(declaration.fields?.values)[index], name = one(target, "name") ?? target;
                    const text = source.slice(name.start, name.end);
                    removeName(text);
                    if (value && ["def", "type"].includes(value.kind)) names.add(text);
                });
            }
            if (scope.kind === "func") array(scope.fields?.params).forEach(parameter => {
                const name = one(parameter, "name"); if (name) removeName(source.slice(name.start, name.end));
            });
            Object.values(scope.fields ?? {}).flat().filter(child => child.start <= node!.start && child.end >= node!.end).forEach(collect);
        };
        collect(tree.root);
        const rootSpan = replacementSpan(tree, node) ?? node;
        const original = source.slice(rootSpan.start, rootSpan.end);
        const targets: AstNode[] = [], freshTypes = new Set<AstNode>();
        if (parent && one(parent, "return_type") === node && freshMarker(parent, source)) freshTypes.add(node);
        const gather = (child: AstNode, owner?: AstNode) => {
            if (owner?.kind === "param" && source.slice(child.start, child.end) === "self^") return;
            if (isTypeNode(child) || child.kind === "self-table") targets.push(child);
            if (freshMarker(child, source)) freshTypes.add(one(child, "return_type")!);
            Object.values(child.fields ?? {}).flat().forEach(part => gather(part, child));
        };
        gather(node);
        const lists = commaLists(tree);
        targets.forEach((target, index) => {
            const span = replacementSpan(tree, target);
            if (!span || span.start < rootSpan.start || span.end > rootSpan.end) return;
            const current = source.slice(span.start, span.end), prefix = index ? `type:part:${index}:` : "";
            const change = (id: string, label: string, edit: SourceEdit) => add(prefix + id, label, edit,
                original.slice(0, edit.start - rootSpan.start) + edit.text + original.slice(edit.end - rootSpan.start));
            const replace = (id: string, label: string, text: string) => change(id, label, { ...span, text });
            if (target.kind !== "self-table") {
                change("type:reference", "Use a named type", { ...span, text: current });
                result[result.length - 1].input = { kind: "typeName", value: validTypeReference(current) ? current : "any^" };
                for (const name of names) if (!owner || !sameName(name, owner.name)) replace(`type:name:${name}`, "Use type", name);
                for (const [id, label, text] of [
                    ["nullable", "Allow nil", `(${current})|nil^`],
                    ["sequence", "Use sequence type", `t^{(${current})[]}`],
                    ["tuple", "Use tuple type", `(${current}, any^)`],
                    ["intersection", "Use intersection type", `(${current})&t^{}`],
                    ["function", "Use function type", `f^any^ -> (${current});`],
                    ["procedure", "Use procedure type", `p^any^ -> (${current});`],
                    ["coroutine", "Use coroutine type", `c^{f^any^ -> any^ -> (${current})}`],
                    ["apply", "Use type descriptor type", `type^<${current}>`],
                ]) if (id !== "tuple" || !freshTypes.has(target)) replace(`type:${id}`, label, text);
            }
            for (const list of lists.filter(list => list.node === target)) {
                const field = ["type-tuple", "type-apply"].includes(target.kind) ? "" : `${list.field}:`;
                list.items.forEach((item, i) => {
                    if (!["type-tuple", "type-apply"].includes(target.kind) || list.items.length > 1) {
                        const remove = removeListElement(source, list, i);
                        if (remove) change(`type:remove:${field}${i}`, "Remove type element", remove);
                    }
                    if (target.kind === "type-func" && list.field === "params") {
                        const mutable = receiverMutation(item, source);
                        if (mutable) change(`type:receiver:${i}:mutable`, mutable.label, mutable.edit);
                    }
                    if (target.kind === "type-table" && !one(item, "key") && one(item, "value")?.kind !== "self-table") {
                        const value = one(item, "value")!;
                        const suffix = syntaxTokens(source, value.end, item.end), open = suffix.find(t => t.text === "[");
                        const close = open && suffix.find(t => t.text === "]" && t.start >= open.end);
                        const count = open && close && suffix.find(t => t.start >= open.end && t.end <= close.start);
                        const at = count ? { start: count.start, end: count.end } : { start: close?.start ?? item.end, end: close?.start ?? item.end };
                        change(`type:position:${i}:count`, "Set fixed position count", { ...at, text: open ? "1" : "[1]" });
                        result[result.length - 1].input = { kind: "count", value: count ? count.text : "1", prefix: open ? "" : "[", suffix: open ? "" : "]" };
                        if (!open || count) change(`type:position:${i}:tail`, "Use unbounded positions", count ? { start: count.start, end: count.end, text: "" } : { start: item.end, end: item.end, text: "[]" });
                        if (open && close) {
                            let gap = source.slice(open.start, close.end);
                            for (const token of syntaxTokens(source, open.start, close.end).reverse()) gap = gap.slice(0, token.start - open.start) + gap.slice(token.end - open.start);
                            change(`type:position:${i}:single`, "Use a single position", { start: open.start, end: close.end, text: gap });
                        }
                    }
                    const key = one(item, "key") ?? one(item, "name");
                    if (["type-table", "self-table"].includes(target.kind) && key && !item.computed) {
                        change(`type:rename:${i}`, "Rename type member", { start: key.start, end: key.end, text: source.slice(key.start, key.end) });
                        result[result.length - 1].input = { value: source.slice(key.start, key.end) };
                    }
                });
                const insertion = { category: "list" as const, kind: target.kind, start: target.start, end: target.end, field: list.field };
                const templates = ["type-table", "self-table"].includes(target.kind) ? listTemplates(tree, insertion) : [{ id: "any", label: "Add type element" }];
                for (const choice of templates) {
                    const append = insertListEdit(tree, insertion, choice.id);
                    const id = `type:append${field ? `:${list.field}` : ""}${["type-table", "self-table"].includes(target.kind) && choice.id !== "typeMember" ? `:${choice.id}` : ""}`;
                    if (append) change(id, choice.label, append);
                }
                if (target.kind === "type-func" && list.field === "params") {
                    const variadic = insertListEdit(tree, { category: "list", kind: target.kind, start: target.start, end: target.end, field: list.field }, "variadic");
                    if (variadic) change("type:append:variadic", "Variadic parameter", variadic);
                    const receiver = insertListEdit(tree, { category: "list", kind: target.kind, start: target.start, end: target.end, field: list.field }, "receiver");
                    if (receiver) change("type:append:receiver", "Receiver parameter", receiver);
                }
            }
            if (target.kind === "type-func") {
                const fresh = freshness(target, source);
                if (fresh) change("function:fresh", fresh.label, fresh.edit);
                const marker = syntaxTokens(source, target.start, target.end).find(t => ["f^", "p^"].includes(t.text));
                if (marker) for (const [id, label, text] of [["function", "Use function type", "f^"], ["procedure", "Use procedure type", "p^"]])
                    change(`function:kind:${id}`, label, { start: marker.start, end: marker.end, text });
            }
            if (target.kind === "type-coro") {
                const tokens = syntaxTokens(source, target.start, target.end), open = tokens.find(t => t.text === "{");
                const close = tokens.filter(t => t.text === "}").slice(-1)[0];
                if (open && close) {
                    const marker = tokens.find(t => t.start >= open.end);
                    const kind = marker && ["f^", "p^"].includes(marker.text) ? marker : undefined;
                    for (const [id, label, text] of [["function", "Use function coroutine", "f^"], ["procedure", "Use procedure coroutine", "p^"], ["either", "Allow either coroutine kind", ""]])
                        change(`coroutine:kind:${id}`, label, { start: kind?.start ?? open.end, end: kind?.end ?? open.end, text });
                    const fields = ["receive", "produce", "result"], parts = fields.map(field => one(target, field));
                    const arrows = tokens.filter(t => t.text === "->" && !parts.some(part => part && t.start >= part.start && t.end <= part.end));
                    const labels = [["Set receive type", "Allow any receive type", "Omit receive type"],
                        ["Set yield type", "Allow any yield type", "Omit yield type"], ["Set final result type", "Allow any final result type", "Omit final result type"]];
                    fields.forEach((field, i) => {
                        const start = i ? arrows[i - 1]?.end : kind?.end ?? open.end, end = arrows[i]?.start ?? close.start;
                        const written = start === undefined ? [] : syntaxTokens(source, start, end);
                        const part = parts[i] && replacementSpan(tree, parts[i]!);
                        const at = part ?? { start: written[0]?.start ?? start ?? close.start, end: written.slice(-1)[0]?.end ?? start ?? close.start };
                        for (const [mode, text, label] of [["type", "any^", labels[i][0]], ["any", "*", labels[i][1]], ["omit", "", labels[i][2]],
                            ...i === 2 ? [["endless", "-", "Coroutine never finishes"]] : []]) {
                            if (mode === "omit" && !written.length) continue;
                            if (mode === "omit" && i === 2 && arrows[1]) {
                                let gap = source.slice(arrows[1].start, close.start);
                                for (const token of syntaxTokens(source, arrows[1].start, close.start).reverse())
                                    gap = gap.slice(0, token.start - arrows[1].start) + gap.slice(token.end - arrows[1].start);
                                change(`coroutine:${field}:${mode}`, label, { start: arrows[1].start, end: close.start, text: gap });
                            } else change(`coroutine:${field}:${mode}`, label, { ...at,
                                text: `${start === undefined ? " -> ".repeat(i - arrows.length) : ""}${text}` });
                        }
                    });
                }
            }
            if (["type-union", "type-intersect"].includes(target.kind)) for (const field of ["left", "right"]) {
                const child = one(target, field), inner = child && replacementSpan(tree, child);
                if (inner) replace(`type:keep:${field}`, field === "left" ? "Keep left type" : "Keep right type", source.slice(inner.start, inner.end));
            }
        });
        return result;
    }
    if (node.kind === "reassign") {
        const operator = assignmentOperator(node, source);
        if (!operator) return [];
        for (const [text, label] of Object.entries(ASSIGNMENT_LABELS))
            add(`assignment:${text}`, label, { start: operator.start, end: operator.end, text: `${operator.nilChecked ? "?" : ""}${text}` });
        add("assignment:nil-check", operator.nilChecked ? "Use ordinary assignment" : "Use nil-checked assignment", {
            start: operator.start, end: operator.end, text: `${operator.nilChecked ? "" : "?"}${operator.base}` });
        return result;
    }
    if (node.kind === "string") {
        const literal = literalOf(node, source);
        if (!literal) return [];
        if (source[node.start] !== '"' || source.startsWith('"""', node.start))
            add("string:quoted", "Use escaped string", { start: node.start, end: node.end, text: quoteString(literal.value) });
        if (source[node.start] !== "'" && !/[\x00-\x1f\x7f]/.test(literal.value))
            add("string:raw", "Use raw string", { start: node.start, end: node.end, text: quoteString(literal.value, true) });
        return result;
    }
    if (node.kind === "param") {
        const mutable = parent && ["func", "type-func"].includes(parent.kind) && receiverMutation(node, source);
        if (mutable) { add("receiver:mutable", mutable.label, mutable.edit); return result; }
        const name = one(node, "name"), fallback = one(node, "fallback"), type = one(node, "type");
        if (!parent || !["func", "error-kind"].includes(parent.kind) || !name || /^self\^+$/.test(source.slice(name.start, name.end))) return [];
        if (fallback) {
            const equal = head.find(t => t.text === "=" && t.start >= (type?.end ?? name.end) && t.end <= fallback.start);
            if (equal) add("default:remove", "Remove default value", { start: equal.start, end: node.end, text: "" });
        } else {
            const text = type && source.slice(type.start, type.end);
            const value = text === "number^" ? "0" : text === "string^" ? '""' : text === "bool^" ? "false^" : type?.kind === "type-table" ? "{}" : "nil^";
            add("default:add", "Add default value", { start: node.end, end: node.end, text: ` = ${value}` });
        }
        return result;
    }
    if (node.kind === "return") {
        if (!callable || syntaxTokens(source, callable.start, callable.end)[0]?.text !== "f^" ||
            parent !== one(callable, "body") || array(parent?.fields?.items).length !== 1 || !array(node.fields?.value).length) return [];
        if (head[0]?.text === "return^") add("return:implicit", "Use implicit return", array(node.fields?.value).length === 1
            ? { start: head[0].start, end: head[0].end, text: "" }
            : { start: head[0].start, end: node.end, text: `(${source.slice(head[0].end, node.end)})` });
        else {
            const siblings = array(parent?.fields?.items), previous = siblings[siblings.length - 2];
            const from = previous?.end ?? syntaxTokens(source, parent!.start, parent!.end)[0].end;
            const prefix = syntaxTokens(source, from, node.start).filter(t => t.text !== ";");
            if (prefix.every(t => t.text === "(")) {
                const at = prefix[0]?.start ?? node.start;
                add("return:explicit", "Use explicit return", { start: at, end: at, text: "return^ " });
            }
        }
        return result;
    }
    if (node.kind === "enum-member") {
        const name = one(node, "name"), values = array(node.fields?.members);
        if (!name) return [];
        if (values.length) {
            const equal = head.find(t => t.start >= name.end && t.text === "=");
            if (equal) add("enum:implicit", "Use implicit enumeration value", { start: equal.start, end: node.end, text: "" });
        } else add("enum:explicit", "Set enumeration value", { start: name.end, end: name.end, text: " = 0" });
        return result;
    }
    if (["define", "enumdef", "errordef"].includes(node.kind)) {
        if (parent === tree.root) {
            const published = head[0]?.text === "public^";
            add("public", published ? "Make declaration private" : "Publish declaration", {
                start: node.start, end: published ? head[0].end : node.start, text: published ? "" : "public^ " });
        }
        const marker = head.find(t => ["let^", "var^"].includes(t.text));
        if (node.kind === "define" && marker) {
            const targets = array(node.fields?.targets).map(target => one(target, "name") ?? target);
            const values = array(node.fields?.values), last = array(node.fields?.targets).slice(-1)[0];
            const operator = last && head.find(t => t.start >= last.end && t.end <= (values[0]?.start ?? node!.end) && ["=", ":="].includes(t.text));
            if (targets.every(target => target.kind === "ident" || source.slice(target.start, target.end) === "_^")) {
                const end = marker.text === "var^" && operator?.text === ":=" ? operator.end : marker.end;
                add("mutability", marker.text === "let^" ? "Make variable mutable" : "Make variable immutable", {
                    start: marker.start, end, text: (marker.text === "let^" ? "var^" : "let^") +
                        source.slice(marker.end, end).replace(/:=$/, "="),
                });
            }
            if (marker.text === "var^") {
                targets.forEach((target, index) => {
                    add(`binding:target:${index}`, "Change declaration target", { start: target.start, end: target.end, text: source.slice(target.start, target.end) });
                    result[result.length - 1].input = { kind: "declarationPath", value: source.slice(target.start, target.end) };
                });
                if (operator) add("binding:existing", operator.text === "=" ? "Allow an existing member" : "Require a new member", {
                    start: operator.start, end: operator.end, text: operator.text === "=" ? ":=" : "=",
                });
            }
        }
        return result;
    }
    if (node.kind === "table-entry") {
        const key = one(node, "key");
        if (!key) return [];
        if (parent?.kind === "table") {
            let end = key.end;
            if (node.computed) {
                let depth = 0;
                const close = head.find(token => {
                    if (token.text === "[") depth++;
                    if (token.text === "]") return --depth === 0;
                    return false;
                });
                if (close) end = close.end;
            }
            if (!node.computed) {
                add("key:string", "Use string key", { start: key.start, end, text: `[${quoteString(nameValue(source.slice(key.start, key.end)))}]` });
                add("key:number", "Use numeric key", { start: key.start, end, text: "[0]" });
            } else {
                if (key.kind !== "string") add("key:string", "Use string key", { start: node.start, end, text: '[""]' });
                if (literalOf(key, source)?.kind !== "number") add("key:number", "Use numeric key", { start: node.start, end, text: "[0]" });
                const value = key.kind === "string" ? quoteName(literalOf(key, source)?.value ?? "") : undefined;
                if (value)
                    add("key:identifier", "Use identifier key", { start: node.start, end, text: value });
            }
            return result;
        }
        if (parent?.kind !== "def") return [];
        const marker = ["override^", "overload^", "abstract^"].includes(head[0]?.text) ? head[0] : undefined;
        const declared = !!node.declared || head.some(t => t.text === ":") && !head.some(t => t.text === "=");
        const choices = declared ? [["abstract^", "Abstract member"]] : [["override^", "Override member"], ["overload^", "Overload member"]];
        if (marker) add("modifier:plain", "Remove member modifier", { start: marker.start, end: marker.end, text: "" });
        for (const [text, label] of choices) if (marker?.text !== text)
            add(`modifier:${text}`, label, { start: marker?.start ?? node.start, end: marker?.end ?? node.start, text: `${text} ` });
        const op = head.find(t => t.text === "op^");
        if (op && key) for (const text of ["<=>", "=", "..", "+", "-", "*", "/", "//", "%", "**", "cross^", "dot^"])
            add(`operator:${text}`, "Define operator", { start: op.end, end: key.end, text }, `op^${text}`);
        return result;
    }
    const match = node.kind === "for" ? one(node, "body") : undefined;
    if (match && ["if-stmt", "if-expr"].includes(match.kind) && ["{", ":"].includes(source[match.start])) {
        const focus = array(node.fields?.focus), marker = head[0];
        const binding = focus[0], targets = binding && array(binding.fields?.targets);
        const header = syntaxTokens(source, node.start, match.start);
        const introduced = ["let^", "var^"].includes(header[1]?.text);
        if (focus.length === 1 && binding?.kind === "define" && targets?.length === 1) {
            if (!introduced) {
                const used = sourceNames(source);
                let name = "subject", serial = 2; while (used.has(name)) name = `subject${serial++}`;
                add("match-focus:bind", "Name the matched value", { start: marker.end, end: marker.end, text: `let^${name} = ` });
            } else {
                const equal = header.find(t => t.text === "=" && t.start >= targets[0].end);
                if (equal) add("match-focus:value", "Use an unnamed matched value", { start: marker.end, end: equal.end, text: " " });
            }
        }
        const branches = array(match.fields?.items), expression = match.kind === "if-expr";
        const close = syntaxTokens(source, node.start, node.end).slice(-1)[0];
        if (!close || !["}", ";"].includes(close.text)) return [];
        const otherwise = branches.find(branch => !one(branch, "condition"));
        const at = otherwise?.start ?? close.start;
        add("match-branch", "Add pattern branch", { start: at, end: at, text: `${newline}when^0: ${expression ? "0 " : ""}${newline}` });
        if (!otherwise) add("match-other", "Add other branch", { start: close.start, end: close.start, text: `${newline}other^: ${expression ? "0 " : ""}${newline}` });
        branches.forEach((branch, index) => {
            if (branches.length > 1 && !(expression && branch === otherwise))
                add(`remove-match:${index}`, `Remove branch ${index + 1}`, { start: branch.start,
                    end: Math.min(branch.end, branches[index + 1]?.start ?? close.start), text: "" });
            const tokens = syntaxTokens(source, branch.start, branch.end);
            if (tokens[0]?.text !== "when^") return;
            let depth = 0;
            const colon = tokens.slice(1).find(token => {
                if (["(", "{", "["].includes(token.text)) depth++;
                if ([")", "}", "]"].includes(token.text)) depth--;
                return token.text === ":" && depth === 0;
            });
            if (!colon) return;
            for (const [id, label, text] of [
                ["number", "Number pattern", "0"], ["string", "String pattern", '""'],
                ["range", "Range pattern", "0 to^1"], ["choices", "Alternative patterns", "0, 1"],
                ["type", "Type pattern", "fits^number^"],
            ]) add(`pattern:${index}:${id}`, label, { start: tokens[0].end, end: colon.start, text }, `${index + 1}: ${text}`);
        });
        return result;
    }
    if (["if-stmt", "if-expr"].includes(node.kind)) {
        // Pattern matching uses generated if nodes with no written if^ keyword.
        if (syntaxTokens(source, node.start, node.end)[0]?.text !== "if^") return [];
        const branches = array(node.fields?.items), expression = node.kind === "if-expr";
        if (!branches.length) return [];
        const otherwise = branches.find(branch => !one(branch, "condition"));
        const close = syntaxTokens(source, node.start, node.end).slice(-1)[0];
        if (!close || close.text !== (expression ? ";" : "}")) return [];
        const handlers = [...array(node.fields?.arms), ...array(node.fields?.extra)];
        const end = Math.min(close.start, ...handlers.map(n => n.start));
        const at = otherwise?.start ?? end;
        add("branch", "Add conditional branch", { start: at, end: at, text: `${newline}el^false^: ${expression ? "0 " : ""}${newline}` });
        if (!otherwise) add("else", "Add else branch", { start: end, end, text: `${newline}el^: ${expression ? "0 " : ""}${newline}` });
        branches.forEach((branch, index) => {
            if (index === 0) {
                const next = branches[1], nextBody = next && one(next, "body"), condition = next && one(next, "condition");
                if (!next && !expression) {
                    const owner = parent?.kind === "for" && one(parent, "body") === node ? parent : node!;
                    add("remove-branch:0", "Remove first branch", { start: owner.start, end: owner.end, text: "" });
                } else if (nextBody) {
                    if (expression && !condition) add("remove-branch:0", "Remove first branch",
                        { start: node!.start, end: node!.end, text: `(${source.slice(nextBody.start, nextBody.end)})` });
                    else add("remove-branch:0", "Remove first branch", { start: node!.start,
                        end: Math.min(nextBody.start, end),
                        text: `if^${condition ? source.slice(condition.start, condition.end) : "true^"}${expression ? ": " : " { "}` });
                }
                return;
            }
            if (expression && !one(branch, "condition")) return;
            add(`remove-branch:${index}`, `Remove branch ${index + 1}`, { start: branch.start, end: Math.min(branch.end, branches[index + 1]?.start ?? end), text: "" });
        });
    } else if (["repeat", "for"].includes(node.kind)) {
        const body = one(node, "body");
        if (body?.kind !== "block") return result;
        const tokens = syntaxTokens(source, body.start, body.end), open = tokens[0], close = tokens.slice(-1)[0];
        if (open?.text !== "{" || close?.text !== "}") return [];
        if (!body.comments?.length) add("body:comment", "Add body comment", {
            start: open.end, end: open.end, text: ` # comment${newline}` });
        const header = syntaxTokens(source, node.start, body.start);
        const conditional = header.some(t => ["while^", "until^"].includes(t.text));
        const ranged = header.some(t => t.text === "from^");
        const bound = one(node, "bound"), focus = array(node.fields?.focus), advance = array(node.fields?.advance);
        const textOf = (n: AstNode | undefined, fallback: string) => n ? source.slice(n.start, n.end) : fallback;
        const used = sourceNames(source);
        let fresh = "i", serial = 2;
        while (used.has(fresh)) fresh = `i${serial++}`;
        const binding = focus[0], target = binding && array(binding.fields?.targets)[0];
        const iterator = iteratorNames(node, source);
        const name = textOf(iterator[iterator.length - 1] ?? target, fresh), initial = iterator.length ? "0" : textOf(binding && array(binding.fields?.values)[0], "0");
        const focusText = ranged || iterator.length ? `var^${name} = ${initial}` : focus.map(n => textOf(n, "")).join(", ");
        const step = advance.length ? ` next^${advance.map(n => textOf(n, "")).join(", ")}`
            : ranged ? ` next^${name} += 1` : "";
        const mode = (id: string, label: string, text: string) => add(`mode:${id}`, label,
            { start: node!.start, end: body.start, text: `${text} ` });
        const prefix = node.kind === "for" ? `for^${focusText} ` : "repeat^";
        const condition = header.find(t => ["while^", "until^"].includes(t.text));
        if (condition) {
            add("mode:while", "Use while loop", { start: condition.start, end: condition.end, text: "while^" });
            add("mode:until", "Use until loop", { start: condition.start, end: condition.end, text: "until^" });
        } else if (iterator.length <= 1) {
            mode("while", "Use while loop", `${prefix}while^true^${step}`);
            mode("until", "Use until loop", `${prefix}until^false^${step}`);
        }
        if (node.kind === "repeat") {
            mode("count", "Use counted loop", `repeat^${conditional ? "1" : textOf(bound, "1")}`);
            mode("forever", "Use infinite loop", "repeat^");
        }
        if (node.kind === "repeat" || iterator.length === 1 || focus.length === 1 && target?.kind === "ident")
            mode("range", "Use range loop", `for^${name} from^${initial} to^${ranged || !conditional && node.kind === "repeat" ? textOf(bound, "1") : "1"}`);
        const order = ["prolog^", "pre^", "first^", "main^", "last^", "epilog^", "finally^"];
        const headers: { name: string; start: number; end: number }[] = [];
        let depth = 0;
        tokens.forEach((token, index) => {
            if (token.text === "{") depth++;
            else if (token.text === "}") depth--;
            else if (depth === 1 && order.includes(token.text) && tokens[index + 1]?.text === ":")
                headers.push({ name: token.text, start: token.start, end: tokens[index + 1].end });
        });
        const implicit = !headers.some(h => h.name === "main^") && array(body.fields?.items).length > 0;
        for (const name of order) {
            if (headers.some(h => h.name === name) || name === "main^" && implicit) continue;
            const next = headers.find(h => order.indexOf(h.name) > order.indexOf(name));
            let at = Math.min(next?.start ?? close.start, ...array(body.fields?.arms).filter(() => order.indexOf(name) <= 3).map(arm => arm.start));
            let text = `${newline}${name}:${newline}`;
            if (order.indexOf(name) < 3 && implicit) {
                at = open.end;
                text += `main^:${newline}`;
            } else if (!headers.length && !implicit && name !== "main^") text += `main^:${newline}`;
            add(`section:${name}`, `Add ${name} section`, { start: at, end: at, text });
        }
        headers.forEach((header, index) => {
            const end = Math.min(headers[index + 1]?.start ?? close.start, ...array(body.fields?.arms).filter(arm => arm.start > header.start).map(arm => arm.start));
            // Retain a main heading when removing it would absorb following code into another section.
            const keepMain = header.name === "main^" && !headers.some(h => h !== header && ["pre^", "first^", "last^"].includes(h.name));
            const needsMain = !implicit && !headers.some(h => h !== header && ["pre^", "first^", "main^", "last^"].includes(h.name));
            const text = keepMain || needsMain ? `main^:${newline}` : "";
            add(`remove-section:${header.name}`, `${keepMain ? "Clear" : "Remove"} ${header.name} section`, { start: header.start, end, text });
        });
        if (ranged) {
            const direction = header.find(t => ["to^", "downto^"].includes(t.text));
            if (direction) add("direction", direction.text === "to^" ? "Use descending range" : "Use ascending range",
                { start: direction.start, end: direction.end, text: direction.text === "to^" ? "downto^" : "to^" });
            const step = header.find(t => t.text === "step^");
            if (step) add("step:remove", "Remove range step", { start: step.start, end: body.start, text: "" });
            else add("step:add", "Set range step", { start: body.start, end: body.start, text: " step^1 " });
        }
        if (conditional && node.kind === "for" && focus.length === 1 && target?.kind === "ident") {
            const value = array(binding.fields?.values)[0], marker = syntaxTokens(source, binding.start, binding.end)[0];
            const operator = value && header.find(t => t.start >= target.end && t.end <= value.start && ["=", ":="].includes(t.text));
            if (operator && array(binding.fields?.values).length === 1) {
                if (binding.kind === "define" && ["var^", "let^"].includes(marker?.text))
                    add("focus:existing", "Assign an existing loop variable", { start: binding.start, end: operator.end,
                        text: `${source.slice(marker.end, operator.start)}:=` });
                else if (binding.kind === "reassign" && operator.text === ":=")
                    add("focus:mutable", "Declare a mutable loop variable", { start: binding.start, end: operator.end,
                        text: `var^${source.slice(binding.start, operator.start)}=` });
            }
            const next = header.find(t => t.text === "next^");
            if (next) add("next:remove", "Remove loop advance", { start: next.start, end: body.start, text: "" });
            else add("next:add", "Add loop advance", { start: body.start, end: body.start, text: ` next^${name} += 1 ` });
        }
        mode("iterator", "Use iterator loop", `for^${iterator.length ? iterator.map(n => textOf(n, "")).join(", ") : name} in^${iterator.length ? `(${textOf(bound, "{}")})` : "({})"}`);
        if (iterator.length === 1) {
            let key = "key", serial = 2; while (used.has(key)) key = `key${serial++}`;
            add("iterator:key:add", "Include iterator key", { start: iterator[0].start, end: iterator[0].start, text: `${key}, ` });
        } else if (iterator.length === 2) add("iterator:key:remove", "Omit iterator key", {
            start: iterator[0].start, end: iterator[1].start, text: "" });
    }
    return result;
}

export const structureTemplates = (tree: AstReply, site: StructureSite): StatementTemplate[] => actions(tree, site);
export function editStructure(tree: AstReply, site: StructureSite, action: string): SourceEdit | undefined {
    const choices = actions(tree, site), choice = choices.find(choice => choice.id === action);
    if (choice && !choice.input) return choice.edit;
    const input = choices.find(choice => choice.input && action.startsWith(`${choice.id}:`));
    const name = input && action.slice(input.id.length + 1);
    return input && name && validStructureInput(input.input!, name) ? { ...input.edit, text: `${input.input!.prefix ?? ""}${name}${input.input!.suffix ?? ""}` } : undefined;
}
