import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as l10n from "@vscode/l10n";
import type { AstReply, FromWebview, ToWebview } from "../../protocol";
import { statementTemplates, type StatementInsertion, type StatementSite, type StatementTemplate } from "../../graphStatements";
import { isListInsertion, listTemplates, groupedOperatorSites, type InsertionSite, type OperatorSite } from "../../graphLists";

type Host = { tree?: AstReply; uri: string; version?: number; post: (message: FromWebview) => void };
type Picker = { id: string; site?: InsertionSite; operator?: OperatorSite; anchor: HTMLElement; version: number;
    choices: StatementTemplate[]; saving?: boolean; error?: string };
const Statements = createContext({
    version: undefined as number | undefined,
    context: (_site?: StatementSite): string | undefined => undefined,
    open: (_site: InsertionSite, _anchor: HTMLElement) => {},
    operator: (_site: OperatorSite, _anchor: HTMLElement) => {},
});
let sequence = 0;
export const useStatementActions = () => useContext(Statements);

export function StatementProvider({ value, children }: { value: Host; children: React.ReactNode }) {
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
        setPicker({ ...current, saving: true, error: undefined });
        const common = { id: current.id, version: current.version };
        if (current.operator) host.current.post({ ...common, type: "replaceOperator",
            start: current.operator.start, end: current.operator.end, operator: template });
        else if (current.site) host.current.post(isListInsertion(current.site)
            ? { ...common, type: "insertElement", site: current.site, template }
            : { ...common, type: "insertStatement", site: current.site, template });
    };
    return <Statements.Provider value={{ version: value.version, open, operator,
        context: site => site ? JSON.stringify({ webviewSection: "statement", lhatStatement: value.version !== undefined,
            lhatGraphUri: value.uri, lhatGraphVersion: value.version, lhatStatementStart: site.start, lhatStatementEnd: site.end }) : undefined }}>
        {children}
        {picker && createPortal(<TemplateMenu key={picker.id} picker={picker} close={close} select={select} />, document.body)}
    </Statements.Provider>;
}

export function StatementButton({ site, append = false, floating = false, axis = "vertical", style }: {
    site: InsertionSite; append?: boolean; floating?: boolean; axis?: "horizontal" | "vertical"; style?: React.CSSProperties;
}) {
    const actions = useStatementActions();
    const title = isListInsertion(site) ? append ? l10n.t("Add element") : l10n.t("Insert element here")
        : append ? l10n.t("Add statement") : l10n.t("Insert statement here");
    return <button type="button" className={`statement-button nodrag nopan nowheel nokey ${append ? "append-statement" : "insert-statement"} ${floating ? "floating-add" : ""} insertion-${axis}`}
        data-vscode-context={JSON.stringify({ lhatStatement: false })} style={style}
        title={title} aria-label={title} aria-haspopup="dialog" disabled={actions.version === undefined}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); actions.open(site, event.currentTarget); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={append || isListInsertion(site) ? "M 12 6 V 18 M 6 12 H 18"
            : axis === "horizontal" ? "M 6 9 L 12 15 L 18 9" : "M 9 6 L 15 12 L 9 18"} /></svg>
    </button>;
}

function TemplateMenu({ picker, close, select }: { picker: Picker; close: (focus?: boolean) => void; select: (template: string) => void }) {
    const menu = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState(""), [index, setIndex] = useState(0);
    const [position, setPosition] = useState({ left: 0, top: 0 });
    const title = picker.operator ? l10n.t("Choose an operator") : picker.site && isListInsertion(picker.site)
        ? l10n.t("Choose an element template") : l10n.t("Choose a statement template");
    const words = query.toLocaleLowerCase().trim().split(/\s+/);
    const filtered = picker.choices.filter(choice => words.every(word =>
        `${l10n.t(choice.label)} ${choice.text}`.toLocaleLowerCase().includes(word)));
    const selected = Math.min(index, Math.max(0, filtered.length - 1));
    useLayoutEffect(() => {
        const place = () => {
            const anchor = picker.anchor.getBoundingClientRect(), bounds = menu.current!.getBoundingClientRect();
            setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)),
                top: Math.max(8, Math.min(anchor.bottom + bounds.height + 5 <= window.innerHeight - 8
                    ? anchor.bottom + 5 : anchor.top - bounds.height - 5, window.innerHeight - bounds.height - 8)) });
        };
        place(); const observer = new ResizeObserver(place); observer.observe(menu.current!);
        return () => observer.disconnect();
    }, [picker.anchor]);
    useEffect(() => {
        input.current?.focus();
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
            placeholder={l10n.t("Filter choices")} aria-label={l10n.t("Filter choices")}
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
