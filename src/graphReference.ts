import * as vscode from "vscode";
import type { AstNode, AstReply, FromWebview, ReferenceTarget } from "./protocol";

const children = (node: AstNode): AstNode[] => Object.values(node.fields ?? {}).flat();
const single = (value: AstNode | AstNode[] | undefined): AstNode | undefined => Array.isArray(value) ? value[0] : value;
const imports = new Set(["import", "require", "import-stmt", "require-stmt"]);
const box = (node: AstNode): ReferenceTarget => ({ start: node.start, end: node.end, box: true });

function pathAt(node: AstNode, offset: number): AstNode[] {
    if (offset < node.start || offset >= node.end || node.kind === "disabled") return [];
    for (const child of children(node)) {
        const path = pathAt(child, offset);
        if (path.length) return [node, ...path];
    }
    return [node];
}

/** Only a written member path, never provenance guessed through function calls. */
function qualified(node: AstNode | undefined): AstNode[] {
    if (!node) return [];
    if (node.kind === "ident" || node.kind === "hat-ident") return [node];
    if (node.kind !== "member") return [];
    const prefix = qualified(single(node.fields?.target));
    const name = single(node.fields?.argument);
    return prefix.length && name?.kind === "ident" ? [...prefix, name] : [];
}

function importValue(node: AstNode | undefined): AstNode | undefined {
    if (!node) return undefined;
    if (imports.has(node.kind)) return node;
    if (node.kind === "member") return importValue(single(node.fields?.target));
    return undefined;
}

function boundImport(path: AstNode[], offset: number): AstNode | undefined {
    const direct = path.find(node => imports.has(node.kind));
    if (direct) return direct;
    for (const node of path) {
        if (node.kind !== "define") continue;
        const targets = node.fields?.targets;
        const values = node.fields?.values;
        if (!Array.isArray(targets) || !Array.isArray(values)) continue;
        const index = targets.findIndex(target => target.start <= offset && offset < target.end);
        const imported = importValue(values[index]);
        if (imported) return imported;
    }
    return undefined;
}

/** Resolve through the language service: same spelling alone is not a binding. */
export async function referenceFromGraph(document: vscode.TextDocument, reply: AstReply,
    message: Extract<FromWebview, { type: "reference" }>, active: () => boolean): Promise<ReferenceTarget | undefined> {
    const current = () => active() && document.version === message.version;
    if (!current() || reply.source !== document.getText() || !Number.isInteger(message.start) ||
        !Number.isInteger(message.end) || message.start < 0 || message.end <= message.start ||
        message.end > reply.source.length || reply.source.slice(message.start, message.end) !== message.text) return;
    const usePath = pathAt(reply.root, message.start);
    const occurrence = usePath[usePath.length - 1];
    if (!occurrence || !["ident", "hat-ident"].includes(occurrence.kind) ||
        occurrence.start !== message.start || occurrence.end !== message.end) return;
    type Site = vscode.Location | vscode.LocationLink;
    const uriOf = (site: Site) => "targetUri" in site ? site.targetUri : site.uri;
    const rangeOf = (site: Site) => "targetUri" in site ? site.targetSelectionRange ?? site.targetRange : site.range;
    // The server canonicalizes Windows filenames (including the drive letter).
    const uriKey = (uri: vscode.Uri) => {
        const value = uri.toString();
        return process.platform === "win32" && value.startsWith("file:") ? value.toLowerCase() : value;
    };
    const local = (site: Site) => uriKey(uriOf(site)) === uriKey(document.uri);
    const cache = new Map<number, Promise<Site[]>>();
    const lookup = (offset: number): Promise<Site[]> => {
        if (!current()) return Promise.resolve([]);
        let answer = cache.get(offset);
        if (!answer) {
            answer = Promise.resolve(vscode.commands.executeCommand<Site[]>(
                "vscode.executeDefinitionProvider", document.uri, document.positionAt(offset)))
                .then(value => current() ? value ?? [] : []);
            cache.set(offset, answer);
        }
        return answer;
    };
    const oneLocal = (sites: Site[]) => {
        const offsets = [...new Set(sites.filter(local).map(site => document.offsetAt(rangeOf(site).start)))];
        return offsets.length === 1 ? offsets[0] : undefined;
    };
    const localTarget = (offset: number): ReferenceTarget | undefined => {
        if (offset === message.start) return;
        const path = pathAt(reply.root, offset);
        const imported = boundImport(path, offset);
        if (imported) return box(imported);
        const name = [...path].reverse().find(node => (node.kind === "ident" || node.kind === "hat-ident") && node.start === offset);
        return name ? { start: name.start, end: name.end } : undefined;
    };
    const sites = await lookup(message.start);
    if (!current()) return;
    const localOffset = oneLocal(sites);
    const direct = localOffset === undefined ? undefined : localTarget(localOffset);
    // A member written here belongs to that local declaration, even when an
    // identically named member is also exported by an imported module.
    if (direct && !direct.box) return direct;

    const chain = usePath.map(qualified).find(parts => parts.length > 0) ?? [];
    const root = chain[0];
    if (!root) return direct;
    const rootOffset = oneLocal(await lookup(root.start));
    if (rootOffset === undefined || !current()) return direct;
    const origin = boundImport(pathAt(reply.root, rootOffset), rootOffset);
    if (!origin) return direct;
    if (origin.kind === "import" || origin.kind === "require") return box(origin); // explicit local alias

    // Namespace roots can be shared by several imports. Choose the matching
    // qualified path, not whichever statement first introduced `std`/`pkg`.
    const visible: AstNode[] = [];
    const collect = (node: AstNode) => {
        if (node.kind === "disabled") return;
        if ((node.kind === "block" || node.kind === "func" || node.kind === "if-clause") && !usePath.includes(node)) return;
        if (node.kind === "import-stmt" || node.kind === "require-stmt") visible.push(node);
        children(node).forEach(collect);
    };
    collect(reply.root);
    if (origin.kind === "import-stmt") {
        const names = chain.map(node => reply.source.slice(node.start, node.end));
        const matching = visible.filter(node => node.kind === "import-stmt").map(node => ({ node, parts: qualified(single(node.fields?.value)) }))
            .filter(({ parts }) => parts.length > 0 && parts.length <= names.length &&
                parts.every((part, index) => reply.source.slice(part.start, part.end) === names[index]));
        const length = Math.max(0, ...matching.map(match => match.parts.length));
        const best = matching.filter(match => match.parts.length === length);
        return best.length === 1 ? box(best[0].node) : undefined;
    }
    const required = visible.filter(node => node.kind === "require-stmt");
    const external = new Set(sites.filter(site => !local(site)).map(site => uriKey(uriOf(site))));
    if (external.size === 0) return required.length === 1 ? box(origin) : undefined;
    // LSP resolves the require literal to its unit. This also handles paths
    // relative to the requiring file without inventing filename heuristics.
    const matches = await Promise.all(required.map(async node => {
        const value = single(node.fields?.value);
        if (!value) return undefined;
        const units = await lookup(value.start);
        return units.some(site => external.has(uriKey(uriOf(site)))) ? node : undefined;
    }));
    if (!current()) return;
    const targets = matches.filter((node): node is AstNode => node !== undefined);
    return targets.length === 1 ? box(targets[0]) : undefined;
}
