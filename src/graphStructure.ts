import type { AstNode, AstReply, SourceSpan } from "./protocol";
import type { SourceEdit } from "./graphReorder";
import type { StatementTemplate } from "./graphStatements";
import { syntaxTokens } from "./graphSyntax";
import { literalOf, quoteString } from "./webview/literals";
import { assignmentOperator, ASSIGNMENT_LABELS } from "./graphAssignments";
import { typeSites } from "./graphTypes";
import { iteratorNames, freshFocus } from "./graphLoops";

export interface StructureSite extends SourceSpan { kind: string }
interface Action extends StatementTemplate { edit: SourceEdit }
const array = (value: AstNode | AstNode[] | undefined): AstNode[] => value ? Array.isArray(value) ? value : [value] : [];
const one = (node: AstNode, field: string) => array(node.fields?.[field])[0];
export function structureSites(tree: AstReply): StructureSite[] {
    const sites: StructureSite[] = [];
    const visit = (node: AstNode) => {
        if (node.kind === "disabled") return;
        if (node.kind.startsWith("type-") || ["if-stmt", "if-expr", "repeat", "for", "define", "reassign", "enumdef", "errordef", "table-entry", "enum-member", "return", "param", "string"].includes(node.kind))
            sites.push({ start: node.start, end: node.end, kind: node.kind });
        Object.values(node.fields ?? {}).flat().forEach(visit);
    };
    visit(tree.root); return sites;
}

function actions(tree: AstReply, site: StructureSite): Action[] {
    let node: AstNode | undefined, parent: AstNode | undefined, callable: AstNode | undefined;
    const find = (candidate: AstNode, owner?: AstNode, enclosing?: AstNode) => {
        if (candidate.kind === "disabled") return;
        if (candidate.kind === site.kind && candidate.start === site.start && candidate.end === site.end) { node = candidate; parent = owner; callable = enclosing; }
        Object.values(candidate.fields ?? {}).flat().forEach(child => find(child, candidate, candidate.kind === "func" ? candidate : enclosing));
    };
    find(tree.root);
    if (!node) return [];
    const source = tree.source, result: Action[] = [], newline = source.includes("\r\n") ? "\r\n" : "\n";
    const add = (id: string, label: string, edit: SourceEdit, preview = edit.text || label) => result.push({ id, label, text: preview, edit });
    const head = syntaxTokens(source, node.start, node.end);
    if (node.kind === "for") {
        add("focus:wrap", "Add an outer local value", { start: node.start, end: node.start, text: `for^let^${freshFocus(source)} = 0 ` });
        const body = one(node, "body");
        if (body?.kind === "for") add("focus:unwrap", "Remove the outer local scope", { start: node.start, end: body.start, text: "" });
    }

    if (node.kind.startsWith("type-")) {
        const names = new Set(["number^", "string^", "bool^", "nil^", "any^", "t^{}"]);
        const owner = typeSites(tree).find(site => site.annotation && site.annotation.start <= node!.start && site.annotation.end >= node!.end);
        const collect = (scope: AstNode) => {
            if (scope.kind === "def") names.add("Self^");
            if (scope.kind === "block") for (const declaration of array(scope.fields?.items)) {
                if (["enumdef", "errordef"].includes(declaration.kind)) {
                    const name = one(declaration, "name"); if (name) names.add(source.slice(name.start, name.end));
                }
                if (declaration.kind === "define") array(declaration.fields?.targets).forEach((target, index) => {
                    const value = array(declaration.fields?.values)[index], name = one(target, "name") ?? target;
                    const text = source.slice(name.start, name.end);
                    if (value && ["def", "type"].includes(value.kind)) names.add(text);
                    else names.delete(text);
                });
            }
            if (scope.kind === "func") array(scope.fields?.params).forEach(parameter => {
                const name = one(parameter, "name"); if (name) names.delete(source.slice(name.start, name.end));
            });
            Object.values(scope.fields ?? {}).flat().filter(child => child.start <= node!.start && child.end >= node!.end).forEach(collect);
        };
        collect(tree.root);
        for (const name of names) if (name !== owner?.name)
            add(`type:name:${name}`, "Use type", { start: node.start, end: node.end, text: name });
        const current = source.slice(node.start, node.end);
        add("type:nullable", "Allow nil", { start: node.start, end: node.end, text: `(${current})|nil^` });
        add("type:sequence", "Use sequence type", { start: node.start, end: node.end, text: `t^{(${current})[]}` });
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
        if (node.kind === "define" && marker && array(node.fields?.targets).every(target => ["ident", "param"].includes(target.kind)))
            add("mutability", marker.text === "let^" ? "Make variable mutable" : "Make variable immutable",
                { start: marker.start, end: marker.end, text: marker.text === "let^" ? "var^" : "let^" });
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
                add("key:string", "Use string key", { start: key.start, end, text: `[${quoteString(source.slice(key.start, key.end))}]` });
                add("key:number", "Use numeric key", { start: key.start, end, text: "[0]" });
            } else {
                if (key.kind !== "string") add("key:string", "Use string key", { start: node.start, end, text: '[""]' });
                if (literalOf(key, source)?.kind !== "number") add("key:number", "Use numeric key", { start: node.start, end, text: "[0]" });
                const value = key.kind === "string" ? literalOf(key, source)?.value : undefined;
                if (value && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(value))
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
                const used = new Set(syntaxTokens(source).map(t => t.text));
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
        const used = new Set(syntaxTokens(source).map(t => t.text));
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
            let at = next?.start ?? close.start, text = `${newline}${name}:${newline}`;
            if (order.indexOf(name) < 3 && implicit) {
                at = open.end;
                text += `main^:${newline}`;
            } else if (!headers.length && !implicit && name !== "main^") text += `main^:${newline}`;
            add(`section:${name}`, `Add ${name} section`, { start: at, end: at, text });
        }
        headers.forEach((header, index) => {
            const end = headers[index + 1]?.start ?? close.start;
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
export const editStructure = (tree: AstReply, site: StructureSite, action: string): SourceEdit | undefined =>
    actions(tree, site).find(choice => choice.id === action)?.edit;
