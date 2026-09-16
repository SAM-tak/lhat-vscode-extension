import type { AstNode, AstReply, TypeSite } from "./protocol";

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
    const visit = (node: AstNode) => {
        if (node.kind === "disabled") return;
        if (node.kind === "define") {
            const targets = list(node.fields?.targets), values = list(node.fields?.values);
            targets.forEach((target, i) => {
                const name = one(target.fields?.name) ?? target;
                add(target, name, one(target.fields?.type), values[i], false);
            });
        } else if (["table-entry", "member-decl"].includes(node.kind)) {
            const name = one(node.fields?.key) ?? one(node.fields?.name);
            if (name) {
                const declared = declaredEntry(node, source);
                const value = one(node.fields?.value) ?? one(node.fields?.fallback);
                add(node, name, one(node.fields?.type) ?? (declared ? value : undefined), declared ? undefined : value, declared);
            }
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
        return site.annotation && site.colon !== undefined
            ? [{ ...site.annotation, text: "" }, { start: site.colon, end: site.colon + 1, text: "" }] : [];
    }
    return site.annotation ? [{ ...site.annotation, text: type }]
        : [{ start: site.insert, end: site.insert, text: `: ${type}` }];
}
