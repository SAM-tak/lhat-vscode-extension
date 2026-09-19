import type { AstNode, AstReply, TypeSite } from "./protocol";
import { resultTypes } from "./graphSyntax";

const one = (value: AstNode | AstNode[] | undefined): AstNode | undefined => Array.isArray(value) ? value[0] : value;
const list = (value: AstNode | AstNode[] | undefined): AstNode[] => value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Find punctuation between AST children without mistaking comments for syntax. */
function punctuation(source: string, start: number, end: number): { char: string; offset: number }[] {
    const result: { char: string; offset: number }[] = [];
    for (let i = start; i < end;) {
        if (source.startsWith("#[", i)) {
            let depth = 1; i += 2;
            while (i < end && depth) {
                if (source.startsWith("#[", i)) { depth++; i += 2; }
                else if (source.startsWith("]#", i)) { depth--; i += 2; }
                else i++;
            }
        } else if (source[i] === "#") {
            while (i < end && source[i] !== "\n") i++;
        } else { if (!/\s/.test(source[i])) result.push({ char: source[i], offset: i }); i++; }
    }
    return result;
}

/** Old servers omit declared: the ':' before a value still disambiguates abstract fields. */
export function declaredEntry(node: AstNode, source: string): boolean {
    if (node.declared !== undefined) return node.declared;
    if (node.kind === "member-decl") return !!node.fields?.value && !node.fields?.fallback;
    const key = one(node.fields?.key), value = one(node.fields?.value);
    return node.kind === "table-entry" && !!key && !!value && !node.fields?.type &&
        punctuation(source, key.end, value.start)[0]?.char === ":";
}

export function typeSites({ root, source }: AstReply): TypeSite[] {
    const sites: TypeSite[] = [];
    const bindingTargets = new Set<AstNode>();
    const add = (owner: AstNode, name: AstNode, annotation: AstNode | undefined, value: AstNode | undefined, required: boolean) => {
        const between = punctuation(source, name.end, annotation?.start ?? value?.start ?? owner.end);
        const colon = between.find(token => token.char === ":")?.offset;
        const closing = between.filter(token => (colon === undefined || token.offset < colon) && (token.char === "]" || token.char === ")"));
        const insert = closing.length ? closing[closing.length - 1].offset + 1 : name.end;
        let annotationSpan = annotation && { start: annotation.start, end: annotation.end };
        if (annotationSpan && colon !== undefined) {
            // Grouping parentheses have no AST node of their own. Include them
            // when replacing/removing the type so '(T)' cannot turn into '()'.
            const opening = between.find(token => token.offset > colon);
            if (opening?.char === "(") annotationSpan.start = opening.offset;
            for (const token of punctuation(source, annotationSpan.end, value?.start ?? owner.end)) {
                if (token.char !== ")") break;
                annotationSpan.end = token.offset + 1;
            }
        }
        let inferred = owner.inferredType ?? value?.inferredType;
        if (!inferred && value && ["int", "float", "string"].includes(value.kind)) inferred = value.kind === "string" ? "string^" : "number^";
        sites.push({ start: name.start, end: name.end, name: source.slice(name.start, name.end), insert,
            annotation: annotationSpan, colon,
            explicit: !!annotation, required, typeText: annotationSpan ? source.slice(annotationSpan.start, annotationSpan.end) : inferred ?? "?" });
    };
    const addReturn = (owner: AstNode) => {
        const annotation = one(owner.fields?.return_type);
        const body = one(owner.fields?.body);
        const limit = body?.start ?? owner.end;
        const symbols = punctuation(source, owner.start, limit);
        const arrowAt = symbols.findIndex((token, index) => token.char === "-" && symbols[index + 1]?.char === ">");
        const operator = arrowAt < 0 ? undefined : { start: symbols[arrowAt].offset, end: symbols[arrowAt + 1].offset + 1 };
        const marker = /[fp]\^/.exec(source.slice(owner.start, limit));
        const markerStart = owner.start + (marker?.index ?? 0);
        const anchor = operator ?? { start: markerStart, end: markerStart + (marker?.[0].length ?? 0) };
        // A procedure without a result has no return type seat to edit. A
        // function does, even when the checker has not inferred it yet.
        if (!annotation && marker?.[0] !== "f^") return;
        const base: TypeSite = {
            start: annotation?.start ?? owner.start,
            end: annotation?.end ?? owner.end,
            name: "return value",
            insert: operator ? operator.end : limit,
            annotation: annotation && { start: annotation.start, end: annotation.end },
            anchor,
            insertionPrefix: " -> ",
            operator,
            explicit: !!annotation,
            required: false,
            typeText: annotation ? source.slice(annotation.start, annotation.end) : owner.inferredReturnType ?? "?",
        };
        const items = annotation?.kind === "type-tuple" ? list(annotation.fields?.items) : [];
        const types = annotation ? items.map(item => source.slice(item.start, item.end)) : resultTypes(owner.inferredReturnType);
        if (types.length > 1) types.forEach((typeText, index) => sites.push({ ...base,
            start: items[index]?.start ?? owner.start, end: items[index]?.end ?? owner.end,
            annotation: items[index] && { start: items[index].start, end: items[index].end },
            name: `return value ${index + 1}`, typeText,
            result: { index, owner: owner.start, types, annotationEnd: annotation?.end },
        }));
        else sites.push(base);
    };
    const visit = (node: AstNode) => {
        if (node.kind === "disabled") return;
        if (node.kind === "define") {
            const targets = list(node.fields?.targets), values = list(node.fields?.values);
            targets.forEach((target, i) => {
                const name = one(target.fields?.name) ?? target;
                bindingTargets.add(target);
                add(target, name, one(target.fields?.type), values[i], values.length === 0);
            });
        } else if (["table-entry", "member-decl"].includes(node.kind)) {
            const name = one(node.fields?.key) ?? one(node.fields?.name);
            if (name) {
                const declared = declaredEntry(node, source);
                const value = one(node.fields?.value) ?? one(node.fields?.fallback);
                add(node, name, one(node.fields?.type) ?? (declared ? value : undefined), declared ? undefined : value, declared);
            }
        } else if (node.kind === "param" && !bindingTargets.has(node)) {
            const name = one(node.fields?.name);
            // self^ is a receiver marker, not an argument a caller supplies.
            if (name && !/^self\^+$/.test(source.slice(name.start, name.end))) {
                add(node, name, one(node.fields?.type), one(node.fields?.fallback), false);
            } else if (!name) {
                const annotation = one(node.fields?.type);
                if (annotation) sites.push({ start: annotation.start, end: annotation.end, name: "parameter type",
                    insert: annotation.start, annotation: { start: annotation.start, end: annotation.end },
                    explicit: true, required: true, typeText: source.slice(annotation.start, annotation.end) });
            }
        } else if (node.kind === "func" || node.kind === "type-func") {
            addReturn(node);
        }
        Object.values(node.fields ?? {}).flat().forEach(visit);
    };
    visit(root);
    return sites;
}

/** Edits touch only annotation syntax; comments and initializer text survive. */
export function typeEdits(site: TypeSite, type: string | undefined): { start: number; end: number; text: string }[] {
    if (type === undefined) {
        if (site.required) throw new Error("This declaration requires a type.");
        if (site.operator && site.annotation) return [{ start: site.operator.start, end: site.result?.annotationEnd ?? site.annotation.end, text: "" }];
        return site.annotation && site.colon !== undefined
            ? [{ ...site.annotation, text: "" }, { start: site.colon, end: site.colon + 1, text: "" }] : [];
    }
    if (site.result && !site.annotation) {
        const types = site.result.types.map((t, i) => i === site.result!.index ? type : t === "?" ? "any^" : t);
        return [{ start: site.insert, end: site.insert, text: ` -> ${types.join(", ")} ` }];
    }
    return site.annotation ? [{ ...site.annotation, text: type }]
        : [{ start: site.insert, end: site.insert, text: `${site.insertionPrefix ?? ": "}${type}` }];
}
