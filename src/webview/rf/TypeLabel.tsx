import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as l10n from "@vscode/l10n";
import type { FromWebview, ToWebview, TypeSite } from "../../protocol";
import { displayType } from "../labels";
import { graphVocabulary } from "../localization";

type TypeContext = { version?: number; post: (message: FromWebview) => void };
type Picker = {
    id: string; site: TypeSite; anchor: HTMLElement; version: number;
    phase: "loading" | "ready" | "saving" | "error";
    candidates: string[]; error?: string;
};
const Types = createContext<{ version?: number; open: (site: TypeSite, anchor: HTMLElement) => void }>({ open: () => {} });
let sequence = 0;

/** One popup for the entire graph: errors and outstanding requests die with it. */
export function TypeProvider({ value, children }: { value: TypeContext; children: React.ReactNode }) {
    const [picker, setPicker] = useState<Picker>();
    const current = useRef<Picker | undefined>(undefined);
    const host = useRef(value); host.current = value;
    const update = (next: Picker | undefined) => { current.current = next; setPicker(next); };
    const close = (focus = false) => {
        const previous = current.current;
        update(undefined);
        if (previous) {
            host.current.post({ type: "cancelType", id: previous.id });
            if (focus && previous.anchor.isConnected) previous.anchor.focus({ preventScroll: true });
        }
    };
    const open = (site: TypeSite, anchor: HTMLElement) => {
        close();
        const version = host.current.version;
        if (version === undefined) return;
        const id = `type-${++sequence}`;
        update({ id, site, anchor, version, phase: "loading", candidates: [] });
        host.current.post({ type: "chooseType", id, start: site.start, end: site.end, resultIndex: site.result?.index, version });
    };
    useEffect(() => { close(); }, [value.version]);
    useEffect(() => {
        const receive = (event: MessageEvent<ToWebview>) => {
            const message = event.data, active = current.current;
            if (!active || !["typeOptions", "typeResult"].includes(message.type) ||
                !("id" in message) || message.id !== active.id) return;
            if (message.type === "typeOptions" && active.phase === "loading") {
                update({ ...active, phase: message.error ? "error" : "ready",
                    candidates: message.candidates ?? [], error: message.error });
            } else if (message.type === "typeResult" && active.phase === "saving") {
                if (message.error) update({ ...active, phase: "error", error: message.error });
                else close(true);
            }
        };
        window.addEventListener("message", receive);
        return () => { window.removeEventListener("message", receive); close(); };
    }, []);
    useEffect(() => {
        if (picker?.phase !== "loading") return;
        // Also recover if the host itself never replies. A late reply cannot
        // overwrite this error or a subsequent request for another label.
        const timer = window.setTimeout(() => {
            const active = current.current;
            if (active?.id !== picker.id || active.phase !== "loading") return;
            host.current.post({ type: "cancelType", id: active.id });
            update({ ...active, phase: "error", error: l10n.t("Loading types took too long. Please retry.") });
        }, 15000);
        return () => window.clearTimeout(timer);
    }, [picker?.id, picker?.phase]);
    const select = (typeText: string | undefined) => {
        const active = current.current;
        if (!active || active.phase === "saving") return;
        if (typeText === undefined ? !active.site.explicit || active.site.required : active.phase !== "ready") return;
        update({ ...active, phase: "saving" });
        host.current.post(typeText === undefined
            ? { type: "removeType", id: active.id, start: active.site.start, end: active.site.end, resultIndex: active.site.result?.index, version: active.version }
            : { type: "applyType", id: active.id, typeText });
    };
    return <Types.Provider value={{ version: value.version, open }}>
        {children}
        {picker && createPortal(<TypeMenu key={picker.id} picker={picker} close={close} select={select}
            retry={() => open(picker.site, picker.anchor)} />, document.body)}
    </Types.Provider>;
}

function TypeMenu({ picker, close, select, retry }: {
    picker: Picker; close: (focus?: boolean) => void;
    select: (typeText: string | undefined) => void; retry: () => void;
}) {
    const menu = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [index, setIndex] = useState(0);
    const [position, setPosition] = useState({ left: 0, top: 0 });
    const listId = `${picker.id}-options`;
    const vocabulary = graphVocabulary();
    const choices = useMemo(() => picker.candidates.map(typeText => ({
        label: displayType(typeText, vocabulary), typeText,
        description: picker.site.explicit && typeText === picker.site.typeText ? l10n.t("Current annotation") : undefined,
    })), [picker.candidates, picker.site, vocabulary]);
    const words = query.toLocaleLowerCase().trim().split(/\s+/);
    const filtered = choices.filter(choice => words.every(word =>
        `${choice.label} ${choice.typeText} ${choice.description ?? ""}`.toLocaleLowerCase().includes(word)));
    const selected = Math.min(index, Math.max(0, filtered.length - 1));
    useLayoutEffect(() => {
        const popup = menu.current;
        if (!popup) return;
        const place = () => {
            const anchor = picker.anchor.getBoundingClientRect(), bounds = popup.getBoundingClientRect();
            const below = anchor.bottom + 5;
            setPosition({
                left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)),
                top: Math.max(8, Math.min(below + bounds.height <= window.innerHeight - 8
                    ? below : anchor.top - bounds.height - 5, window.innerHeight - bounds.height - 8)),
            });
        };
        place();
        const observer = new ResizeObserver(place); observer.observe(popup);
        return () => observer.disconnect();
    }, [picker.anchor]);
    useEffect(() => { input.current?.focus(); }, []);
    useEffect(() => {
        menu.current?.querySelector(`#${listId}-${selected}`)?.scrollIntoView({ block: "nearest" });
    }, [selected, query, picker.phase]);
    useEffect(() => {
        const outside = (event: Event) => {
            if (!menu.current?.contains(event.target as Node)) close();
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
        };
        const resized = () => close();
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("wheel", outside, { capture: true, passive: true });
        document.addEventListener("focusin", outside);
        document.addEventListener("keydown", escape, true);
        window.addEventListener("resize", resized);
        return () => {
            document.removeEventListener("pointerdown", outside, true);
            document.removeEventListener("wheel", outside, true);
            document.removeEventListener("focusin", outside);
            document.removeEventListener("keydown", escape, true);
            window.removeEventListener("resize", resized);
        };
    }, []);
    return <div ref={menu} className="type-menu nodrag nopan nowheel nokey" role="dialog"
        aria-label={l10n.t("Type of {0}", picker.site.name)} style={position}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}>
        <div className="type-menu-header"><span>{l10n.t("Type of {0}", picker.site.name)}</span>
            <button type="button" className="type-menu-close" aria-label={l10n.t("Close type menu")}
                onClick={() => close(true)}>×</button></div>
        {picker.site.explicit && <button type="button" className="type-menu-infer"
            disabled={picker.site.required || picker.phase === "saving"}
            title={picker.site.required ? l10n.t("This declaration requires a type.") : undefined}
            onClick={() => select(undefined)}>{l10n.t("Remove annotation (infer type)")}</button>}
        <input ref={input} role="combobox" aria-expanded="true" aria-autocomplete="list"
            aria-controls={listId} aria-activedescendant={picker.phase === "ready" && filtered.length ? `${listId}-${selected}` : undefined}
            aria-label={l10n.t("Filter types")} placeholder={l10n.t("Filter types")}
            value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }}
            onKeyDown={event => {
                if (event.nativeEvent.isComposing || picker.phase !== "ready") return;
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    setIndex(event.key === "Home" ? 0 : event.key === "End" ? Math.max(0, filtered.length - 1)
                        : Math.max(0, Math.min(filtered.length - 1, selected + (event.key === "ArrowDown" ? 1 : -1))));
                } else if (event.key === "Enter" && filtered[selected]) { event.preventDefault(); select(filtered[selected].typeText); }
            }} />
        {picker.phase === "loading" || picker.phase === "saving"
            ? <div className="type-menu-status" role="status">{picker.phase === "loading" ? l10n.t("Loading types…") : l10n.t("Applying type…")}</div>
            : picker.phase === "error" ? <div className="type-menu-status">
                <div role="alert">{picker.error}</div><button type="button" onClick={retry}>{l10n.t("Retry")}</button>
            </div> : <>
                <div id={listId} role="listbox" className="type-menu-options" aria-label={l10n.t("Available types")}>
                    {filtered.map((choice, i) => <div key={choice.typeText ?? "<inferred>"} id={`${listId}-${i}`}
                        role="option" aria-selected={i === selected} className="type-menu-option"
                        onPointerMove={() => setIndex(i)} onMouseDown={event => event.preventDefault()}
                        onClick={() => select(choice.typeText)}>
                        <span>{choice.label}</span>{choice.description && <small>{choice.description}</small>}
                    </div>)}
                </div>
                {!filtered.length && <div className="type-menu-status" role="status">{choices.length
                    ? l10n.t("No types match this filter.") : l10n.t("No compatible types are available at this location.")}</div>}
            </>}
    </div>;
}

/** One visual language for literal types, binding types and member types. */
export function TypeLabel({ label, site }: { label: string; site?: TypeSite }) {
    const context = useContext(Types);
    const vocabulary = graphVocabulary();
    const fullType = useMemo(() => site ? displayType(site.typeText, vocabulary) : label,
        [site?.typeText, label, vocabulary]);
    const origin = site?.explicit ? l10n.t("Explicit type annotation") : l10n.t("Inferred type");
    const className = `type-label semantic-label ${site?.explicit ? "type-explicit" : "type-inferred"}`;
    if (!site) return <span className={className} data-category="type" title={origin}>{label}</span>;
    return <button type="button" className={`${className} nodrag nopan nowheel nokey`}
        data-category="type" aria-label={l10n.t("{0}: {1}. Choose type", site.name, label)} aria-haspopup="dialog"
        disabled={context.version === undefined}
        title={`${origin}: ${fullType}\n${l10n.t("Click to choose a type")}`}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); context.open(site, event.currentTarget); }}>{label}</button>;
}
