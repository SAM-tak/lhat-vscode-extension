import { structureSites, structureTemplates, validStructureInput, type StructureSite } from "../../graphStructure";
import { deleteSites, type DeleteSite } from "../../graphDelete";
import { expressionSites, expressionTemplates, validExpressionReference, type ExpressionSite } from "../../graphExpressions";
import type { AnnotationOwner } from "../../graphAnnotations";
import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as l10n from "@vscode/l10n";
import type { AstReply, FromWebview, ToWebview, SourceSpan } from "../../protocol";
import { statementTemplates, type StatementInsertion, type StatementSite, type StatementTemplate } from "../../graphStatements";
import { isListInsertion, listTemplates, groupedOperatorSites, type InsertionSite, type OperatorSite } from "../../graphLists";
import type { InterpolationSite } from "../../graphInterpolation";
import { commentTargets, type CommentTarget } from "../../graphComments";

type Host = { tree?: AstReply; uri: string; version?: number; post: (message: FromWebview) => void };
type FoldContext = { foldable: boolean; foldKey?: string; start?: number; sourceEnd?: number };
type Picker = { id: string; site?: InsertionSite; operator?: OperatorSite; anchor: HTMLElement; version: number;
    point?: { x: number; y: number };
    structure?: StructureSite; interpolation?: InterpolationSite; expression?: ExpressionSite;
    title?: string; apply?: (template: string) => Promise<string | undefined>;
    choices: StatementTemplate[]; input?: StatementTemplate; saving?: boolean; error?: string };
const Statements = createContext({
    version: undefined as number | undefined,
    context: (_site?: StatementSite, _fold?: FoldContext, _annotation?: AnnotationOwner): string | undefined => undefined,
    open: (_site: InsertionSite, _anchor: HTMLElement) => {},
    templates: (_title: string, _choices: StatementTemplate[], _anchor: HTMLElement, _apply: NonNullable<Picker["apply"]>) => {},
    operator: (_site: OperatorSite, _anchor: HTMLElement) => {},
    structures: [] as StructureSite[],
    structure: (_site: StructureSite, _anchor: HTMLElement) => {},
    deletions: [] as DeleteSite[],
    remove: (_site: DeleteSite) => {},
    comments: [] as CommentTarget[],
    comment: (_site: SourceSpan, _action: "add" | "remove") => {},
    expressions: [] as ExpressionSite[],
    expression: (_site: ExpressionSite, _anchor: HTMLElement) => {},
    interpolation: (_site: InterpolationSite, _anchor: HTMLElement) => {},
});
let sequence = 0;
export const useStatementActions = () => useContext(Statements);

export function StatementProvider({ value, children }: { value: Host; children: React.ReactNode }) {
    const structures = useMemo(() => value.tree ? structureSites(value.tree).filter(site => site.kind.startsWith("type-") || structureTemplates(value.tree!, site).length) : [], [value.tree]);
    const deletions = useMemo(() => value.tree ? deleteSites(value.tree) : [], [value.tree]);
    const expressions = useMemo(() => value.tree ? expressionSites(value.tree) : [], [value.tree]);
    const comments = useMemo(() => value.tree ? commentTargets(value.tree) : [], [value.tree]);
    const [picker, setPicker] = useState<Picker>();
    const active = useRef(picker); active.current = picker;
    const host = useRef(value); host.current = value;
    const close = (focus = false) => {
        if (focus && active.current?.anchor.isConnected) active.current.anchor.focus({ preventScroll: true });
        active.current = undefined; setPicker(undefined);
    };
    useEffect(() => { close(); }, [value.version, value.tree?.source]);
    useEffect(() => {
        const receive = ({ data }: MessageEvent<ToWebview>) => {
            if (data.type !== "statementResult" || data.id !== active.current?.id) return;
            if (data.error) setPicker({ ...active.current, saving: false, error: data.error });
            else close(true);
        };
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
    }, []);
    const open = (site: InsertionSite, anchor: HTMLElement) => {
        const { tree, version } = host.current;
        if (!tree || version === undefined) return;
        const choices = isListInsertion(site) ? listTemplates(tree, site) : statementTemplates(tree, site);
        setPicker({ id: `statement-${++sequence}`, site, anchor, version, choices });
    };
    const operator = (site: OperatorSite, anchor: HTMLElement) => {
        const { tree, version } = host.current;
        if (!tree || version === undefined) return;
        const current = groupedOperatorSites(tree).find(s => s.start === site.start && s.end === site.end);
        if (current) setPicker({ id: `operator-${++sequence}`, operator: current, anchor, version,
            choices: current.choices.map(text => ({ id: text, text, label: text })) });
    };
    const select = (template: string) => {
        const current = active.current;
        if (!current || current.saving || host.current.version !== current.version) return;
        const input = current.choices.find(choice => choice.id === template && choice.input);
        if (input) { setPicker({ ...current, input }); return; }
        setPicker({ ...current, saving: true, error: undefined });
        if (current.apply) {
            void current.apply(template).then(error => {
                if (active.current?.id !== current.id) return;
                if (error) setPicker({ ...current, saving: false, error });
                else close(true);
            });
            return;
        }
        const common = { id: current.id, version: current.version };
        if (current.structure) host.current.post({ ...common, type: "editStructure", site: current.structure, action: template });
        else if (current.expression) host.current.post({ ...common, type: "replaceExpression", site: current.expression, template });
        else if (current.interpolation) host.current.post({ ...common, type: "editInterpolation", site: current.interpolation, value: template });
        else if (current.operator) host.current.post({ ...common, type: "replaceOperator",
            start: current.operator.start, end: current.operator.end, operator: template });
        else if (current.site) host.current.post(isListInsertion(current.site)
            ? { ...common, type: "insertElement", site: current.site, template }
            : { ...common, type: "insertStatement", site: current.site, template });
    };
    const interpolation = (site: InterpolationSite, anchor: HTMLElement) => {
        const { version } = host.current;
        if (version === undefined) return;
        setPicker({ id: `interpolation-add-${++sequence}`, interpolation: site, anchor, version, choices: [
            { id: "text", label: "Text fragment", text: "text" },
            { id: "expression", label: "Interpolation expression", text: "{nil^}" },
        ] });
    };
    const expression = (site: ExpressionSite, anchor: HTMLElement) => {
        const { tree, version } = host.current;
        if (!tree || version === undefined) return;
        setPicker({ id: `expression-${++sequence}`, expression: site, anchor, version,
            choices: expressionTemplates(tree, site) });
    };
    const structure = (site: StructureSite, anchor: HTMLElement) => {
        const { tree, version } = host.current;
        if (!tree || version === undefined) return;
        setPicker({ id: `structure-${++sequence}`, structure: site, anchor, version, choices: structureTemplates(tree, site) });
    };
    const remove = (site: DeleteSite) => {
        const { version } = host.current;
        if (version !== undefined) host.current.post({ type: "deleteElement", id: `delete-${++sequence}`, site, version });
    };
    const templates = (title: string, choices: StatementTemplate[], anchor: HTMLElement, apply: NonNullable<Picker["apply"]>) => {
        const { version } = host.current;
        if (version !== undefined) setPicker({ id: `argument-${++sequence}`, title, choices, anchor, version, apply });
    };
    const comment = (site: SourceSpan, action: "add" | "remove") => {
        const { version } = host.current;
        if (version !== undefined) host.current.post({ type: "editComment", id: `comment-${++sequence}`, site, action, version });
    };
    useEffect(() => {
        const contextMenu = (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            if (event.defaultPrevented || target.closest('textarea, input, select, [contenteditable="true"], .statement-menu')) return;
            event.preventDefault(); event.stopPropagation();
            const anchor = target.closest<HTMLElement>('[data-vscode-context]');
            if (!anchor || value.version === undefined) return;
            const context = JSON.parse(anchor.dataset.vscodeContext ?? "{}");
            const actions: { id: string; label: string; run: () => void }[] = [];
            if (context.lhatCommentTarget) actions.push({ id: "comment-add", label: "Add comment", run: () => comment(context.lhatCommentTarget, "add") });
            if (context.lhatCommentBlock) actions.push({ id: "comment-remove", label: "Delete comment", run: () => comment(context.lhatCommentBlock, "remove") });
            if (context.lhatCanAddAnnotation) actions.push({ id: "annotation", label: "Add annotation", run: () => window.dispatchEvent(new MessageEvent("message", { data: {
                type: "showAnnotations", ownerStart: context.lhatAnnotationStart, ownerEnd: context.lhatAnnotationEnd,
                ownerKind: context.lhatAnnotationKind, version: value.version } })) });
            if (context.lhatFoldable) actions.push({ id: "fold", label: "Toggle Fold/Unfold", run: () => window.dispatchEvent(new MessageEvent("message", { data: {
                type: "toggleFold", key: context.lhatFoldKey, version: value.version } })) });
            if (context.lhatStatement) actions.push({ id: "toggle", label: "Toggle statement enabled", run: () => value.post({ type: "toggleStatement",
                id: `toggle-${++sequence}`, start: context.lhatStatementStart, end: context.lhatStatementEnd, version: value.version! }) });
            if (actions.length) setPicker({ id: `context-${++sequence}`, title: "Node actions", anchor, version: value.version,
                point: event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined,
                choices: actions.map(action => ({ id: action.id, label: action.label, text: "" })),
                apply: async id => { actions.find(action => action.id === id)?.run(); return undefined; } });
        };
        document.addEventListener("contextmenu", contextMenu);
        return () => document.removeEventListener("contextmenu", contextMenu);
    }, [value, comments]);
    return <Statements.Provider value={{ structures, structure, deletions, remove, comments, comment, version: value.version, open, templates, operator, interpolation, expression, expressions,
        context: (site, fold, annotation) => JSON.stringify({ webviewSection: "statement", lhatStatement: !!site && value.version !== undefined,
            lhatGraphUri: value.uri, lhatGraphVersion: value.version, lhatStatementStart: site?.start, lhatStatementEnd: site?.end,
            lhatFoldable: !!fold?.foldable && !!fold.foldKey && value.version !== undefined, lhatFoldKey: fold?.foldKey,
            lhatCanAddAnnotation: !!annotation?.canAdd && value.version !== undefined,
            lhatAnnotationStart: annotation?.start, lhatAnnotationEnd: annotation?.end, lhatAnnotationKind: annotation?.kind,
            lhatCommentTarget: fold?.foldKey?.startsWith("comment:") ? undefined : comments.find(node => node.start === fold?.start && node.end === fold?.sourceEnd),
            lhatCommentBlock: fold?.foldKey?.startsWith("comment:") ? { start: fold.start, end: fold.sourceEnd } : undefined }) }}>
        {children}
        {picker && createPortal(<TemplateMenu key={`${picker.id}:${picker.input?.id ?? ""}`} picker={picker} close={close} select={select} />, document.body)}
    </Statements.Provider>;
}

export function CommentButton({ start, end, remove = false }: { start?: number; end?: number; remove?: boolean }) {
    const actions = useStatementActions();
    const site = remove && start !== undefined && end !== undefined ? { start, end }
        : actions.comments.find(node => node.start === start && node.end === end);
    if (!site) return null;
    const title = l10n.t(remove ? "Delete comment" : "Add comment");
    return <button type="button" className={`${remove ? "comment-delete element-delete" : "add-comment statement-button"} nodrag nopan nokey`}
        title={title} aria-label={title} disabled={actions.version === undefined}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); actions.comment(site, remove ? "remove" : "add"); }}>
        {remove ? "×" : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M 5 4 H 19 V 15 H 11 L 5 20 Z M 9 9 H 15 M 12 6 V 12" /></svg>}
    </button>;
}

export function StatementButton({ site, append = false, floating = false, axis = "vertical", style }: {
    site: InsertionSite; append?: boolean; floating?: boolean; axis?: "horizontal" | "vertical"; style?: React.CSSProperties;
}) {
    const actions = useStatementActions();
    const title = isListInsertion(site) ? append ? l10n.t("Add element") : l10n.t("Insert element here")
        : append ? l10n.t("Add statement") : l10n.t("Insert statement here");
    return <InsertionButton site={site} title={title} append={append} floating={floating} axis={axis} style={style}
        plus={append || isListInsertion(site)} disabled={actions.version === undefined}
        onOpen={anchor => actions.open(site, anchor)} />;
}

export function InsertionIcon({ plus = true, axis = "horizontal" }: { plus?: boolean; axis?: "horizontal" | "vertical" }) {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={plus ? "M 12 6 V 18 M 6 12 H 18"
        : axis === "horizontal" ? "M 6 9 L 12 15 L 18 9" : "M 9 6 L 15 12 L 9 18"} /></svg>;
}

export function InsertionButton({ site, title, append = true, floating = false, axis = "horizontal", style, plus = true, disabled, onOpen }: {
    site?: InsertionSite;
    title: string; append?: boolean; floating?: boolean; axis?: "horizontal" | "vertical"; style?: React.CSSProperties;
    plus?: boolean; disabled?: boolean; onOpen: (anchor: HTMLElement) => void;
}) {
    return <button type="button" className={`statement-button nodrag nopan nowheel nokey ${append ? "append-statement" : "insert-statement"} ${floating ? "floating-add" : ""} insertion-${axis}`}
        data-insertion-site={site ? JSON.stringify(site) : undefined}
        data-vscode-context={JSON.stringify({ lhatStatement: false, lhatFoldable: false })} style={style}
        title={title} aria-label={title} aria-haspopup="dialog" disabled={disabled}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); onOpen(event.currentTarget); }}>
        <InsertionIcon plus={plus} axis={axis} />
    </button>;
}

function TemplateMenu({ picker, close, select }: { picker: Picker; close: (focus?: boolean) => void; select: (template: string) => void }) {
    const menu = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState(picker.input?.input?.value ?? ""), [index, setIndex] = useState(0);
    const [position, setPosition] = useState({ left: 0, top: 0 });
    const inputUi = picker.input?.input?.kind === "count"
        ? { title: l10n.t("Number of positions"), placeholder: l10n.t("Enter position count"), label: "Use position count" }
        : picker.input?.input?.kind === "catchType"
        ? { title: l10n.t("Catch filter"), placeholder: l10n.t("Enter an error kind or alternatives"), label: "Use catch filter" }
        : picker.input?.input?.kind === "typeName"
        ? { title: l10n.t("Named type"), placeholder: l10n.t("Enter a type name"), label: "Use type name" }
        : picker.input?.input?.kind === "declarationPath"
        ? { title: l10n.t("Change declaration target"), placeholder: l10n.t("Enter a declaration name or member path"), label: "Use declaration target" }
        : ["stringEscapes", "interpolationEscapes"].includes(picker.input?.input?.kind ?? "")
        ? { title: l10n.t("Edit string escapes"), placeholder: l10n.t("Enter string content with escapes"), label: "Use string content" }
        : { title: l10n.t("Rename type member"), placeholder: l10n.t("Enter member name"), label: "Use member name" };
    const title = picker.input ? inputUi.title : picker.title ? l10n.t(picker.title) : (picker.structure ? l10n.t("Edit structure") : picker.expression ? l10n.t("Change expression") : picker.interpolation ? l10n.t("Add interpolation part") : picker.operator ? l10n.t("Choose an operator") : picker.site && isListInsertion(picker.site)
        ? l10n.t("Choose an element template") : l10n.t("Choose a statement template"));
    const inputValue = ["stringEscapes", "interpolationEscapes"].includes(picker.input?.input?.kind ?? "") ? query : query.trim();
    const choices = picker.input ? validStructureInput(picker.input.input!, inputValue)
        ? [{ id: `${picker.input.id}:${inputValue}`, label: inputUi.label, text: inputValue }] : []
        : picker.expression && validExpressionReference(picker.expression, query.trim()) && !picker.choices.some(c => c.id === `reference:${query.trim()}`)
        ? [...picker.choices, { id: `reference:${query.trim()}`, label: query.trim(), text: query.trim() }] : picker.choices;
    const words = query.toLocaleLowerCase().trim().split(/\s+/);
    const filtered = choices.filter(choice => words.every(word =>
        `${l10n.t(choice.label)} ${choice.label} ${choice.text}`.toLocaleLowerCase().includes(word)))
        .sort((a, b) => Number(b.id === `reference:${query.trim()}`) - Number(a.id === `reference:${query.trim()}`));
    const selected = Math.min(index, Math.max(0, filtered.length - 1));
    useLayoutEffect(() => {
        const place = () => {
            const anchor = picker.point ? new DOMRect(picker.point.x, picker.point.y, 0, 0) : picker.anchor.getBoundingClientRect(), bounds = menu.current!.getBoundingClientRect();
            setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)),
                top: Math.max(8, Math.min(anchor.bottom + bounds.height + 5 <= window.innerHeight - 8
                    ? anchor.bottom + 5 : anchor.top - bounds.height - 5, window.innerHeight - bounds.height - 8)) });
        };
        place(); const observer = new ResizeObserver(place); observer.observe(menu.current!);
        return () => observer.disconnect();
    }, [picker.anchor]);
    useEffect(() => {
        input.current?.focus();
        if (picker.input) input.current?.select();
        const outside = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close(); };
        const key = (event: KeyboardEvent) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
        };
        const resize = () => close();
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("wheel", outside, { capture: true, passive: true });
        document.addEventListener("focusin", outside);
        document.addEventListener("keydown", key, true);
        window.addEventListener("resize", resize);
        return () => {
            document.removeEventListener("pointerdown", outside, true);
            document.removeEventListener("wheel", outside, true);
            document.removeEventListener("focusin", outside);
            document.removeEventListener("keydown", key, true);
            window.removeEventListener("resize", resize);
        };
    }, []);
    useEffect(() => { menu.current?.querySelector(`[data-template-index="${selected}"]`)?.scrollIntoView({ block: "nearest" }); }, [selected]);
    return <div ref={menu} className="type-menu statement-menu nodrag nopan nowheel nokey" role="dialog"
        aria-label={title} style={position}
        onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <div className="type-menu-header"><span>{title}</span>
            <button type="button" aria-label={l10n.t("Close menu")} onClick={() => close(true)}>×</button></div>
        <input ref={input} role="combobox" aria-expanded="true" aria-controls={`${picker.id}-options`}
            aria-activedescendant={filtered.length ? `${picker.id}-${selected}` : undefined}
            data-name-input={picker.input ? true : undefined}
            placeholder={picker.input ? inputUi.placeholder : picker.expression ? l10n.t("Filter choices or enter a reference name") : l10n.t("Filter choices")} aria-label={picker.input ? inputUi.placeholder : l10n.t("Filter choices")}
            disabled={picker.saving} value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }}
            onKeyDown={event => {
                if (event.nativeEvent.isComposing || picker.saving) return;
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                    event.preventDefault(); setIndex(event.key === "Home" ? 0 : event.key === "End" ? filtered.length - 1
                        : Math.max(0, Math.min(filtered.length - 1, selected + (event.key === "ArrowDown" ? 1 : -1))));
                } else if (event.key === "Enter" && filtered[selected]) { event.preventDefault(); select(filtered[selected].id); }
            }} />
        {picker.error && <div className="type-menu-status" role="alert">{picker.error}</div>}
        {picker.saving ? <div className="type-menu-status" role="status">{l10n.t("Applying edit…")}</div> :
            <div id={`${picker.id}-options`} role="listbox" className="type-menu-options">
                {filtered.map((choice, i) => <div key={choice.id} id={`${picker.id}-${i}`} role="option" aria-selected={i === selected}
                    className="type-menu-option" data-template-index={i} onPointerMove={() => setIndex(i)}
                    onMouseDown={event => event.preventDefault()} onClick={() => select(choice.id)}>
                    <span>{l10n.t(choice.label)}</span>{!picker.operator && <small>{choice.text.split("\n")[0]}</small>}
                </div>)}
                {!filtered.length && <div className="type-menu-status">{l10n.t("No choices match this filter.")}</div>}
            </div>}
    </div>;
}


export function ExpressionButton({ start, end }: { start?: number; end?: number }) {
    const actions = useStatementActions();
    const site = actions.expressions.find(site => site.start === start && site.end === end)
        ?? actions.expressions.find(site => site.owner && site.owner.start === start && site.owner.end === end);
    if (!site) return null;
    return <button type="button" className="expression-edit nodrag nopan nokey" title={l10n.t("Change expression")}
        data-expression-start={site.start} data-expression-end={site.end}
        aria-label={l10n.t("Change expression")} disabled={actions.version === undefined}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); actions.expression(site, event.currentTarget); }}>✎</button>;
}


export function DeleteButton({ start, end, declaration, owner }: { start?: number; end?: number; declaration?: StatementSite; owner?: SourceSpan }) {
    const actions = useStatementActions();
    const site = (owner && actions.deletions.find(site => site.start === owner.start && site.end === owner.end))
        ?? actions.deletions.find(site => site.start === start && site.end === end)
        ?? (declaration && actions.deletions.find(site => site.category === "statement" && site.start === declaration.start && site.end === declaration.end));
    if (!site) return null;
    return <button type="button" className="element-delete nodrag nopan nokey" title={l10n.t("Delete element")}
        data-delete-start={site.start} data-delete-end={site.end}
        aria-label={l10n.t("Delete element")} disabled={actions.version === undefined}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); actions.remove(site); }}>×</button>;
}


export function StructureButton({ start, end, declaration }: { start?: number; end?: number; declaration?: StatementSite }) {
    const actions = useStatementActions();
    const site = actions.structures.find(site => site.start === start && site.end === end)
        ?? actions.structures.find(site => site.start === start && ["table-entry", "enum-member", "param"].includes(site.kind))
        ?? (declaration && actions.structures.find(site => site.start === declaration.start && site.end === declaration.end));
    if (!site) return null;
    return <button type="button" className="structure-edit nodrag nopan nokey" title={l10n.t("Edit structure")}
        data-structure-start={site.start} data-structure-end={site.end}
        aria-label={l10n.t("Edit structure")} disabled={actions.version === undefined}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); actions.structure(site, event.currentTarget); }}>⋯</button>;
}
