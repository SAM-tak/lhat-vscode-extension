import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import * as l10n from "@vscode/l10n";
import type { ClipboardTarget } from "../../graphClipboard";
import type { FromWebview, ToWebview } from "../../protocol";

export function clipboardTarget(element: Element | null): ClipboardTarget | undefined {
    if (!element || element.closest('.statement-menu, .type-menu, #bar, #trail')) return undefined;
    const annotation = element.closest<HTMLElement>('.annotation-row');
    if (annotation) return { category: "annotation", start: Number(annotation.dataset.annotationStart), end: Number(annotation.dataset.annotationEnd) };
    const box = element.closest<HTMLElement>('.box[data-source-start], .call-tree-surface[data-source-start]');
    if (!box) return undefined;
    return { category: box.classList.contains("annotation-box") ? "annotations" : box.classList.contains("comment-box") ? "comment" : "node",
        start: Number(box.dataset.sourceStart), end: Number(box.dataset.sourceEnd), kind: box.dataset.sourceKind };
}

type Action = "copy" | "cut" | "paste";
const Clipboard = createContext({ insert: true, toggle: () => {},
    act: (_action: Action, _target?: ClipboardTarget) => {}, available: false });
export const useGraphClipboard = () => useContext(Clipboard);
let sequence = 0;

export function ClipboardProvider({ version, post, children }: {
    version?: number; post: (message: FromWebview) => void; children: React.ReactNode;
}) {
    const [insert, setInsert] = useState(true);
    const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
    const pending = useRef<string | undefined>(undefined);
    const current = useRef({ version, post, insert }); current.current = { version, post, insert };
    const act = (action: Action, target?: ClipboardTarget) => {
        const host = current.current;
        if (host.version === undefined || pending.current) return;
        target ??= pointer.current && clipboardTarget(document.elementFromPoint(pointer.current.x, pointer.current.y));
        if (!target || !Number.isInteger(target.start) || !Number.isInteger(target.end)) return;
        const id = `clipboard-${++sequence}`;
        pending.current = id;
        host.post({ type: "clipboard", id, action, target, insert: host.insert, version: host.version });
    };
    useEffect(() => {
        const editing = () => document.activeElement?.matches('input, textarea, select, [contenteditable="true"]') ||
            document.activeElement?.closest('.statement-menu, .type-menu, .svg-export-menu');
        const move = (event: PointerEvent) => { pointer.current = { x:event.clientX, y:event.clientY }; };
        const leave = () => { pointer.current = undefined; };
        const out = (event: PointerEvent) => { if (!event.relatedTarget) leave(); };
        const key = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing || editing()) return;
            if (event.key === "Insert" && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
                event.preventDefault(); event.stopPropagation();
                if (!event.repeat) setInsert(value => !value);
                return;
            }
            const command = event.ctrlKey || event.metaKey;
            const shortcuts: Record<string, Action> = { c:"copy", x:"cut", v:"paste", insert:"copy" };
            const action: Action | undefined = !event.altKey && !event.shiftKey && command
                ? shortcuts[event.key.toLowerCase()]
                : !command && event.shiftKey ? event.key === "Insert" ? "paste" : event.key === "Delete" ? "cut" : undefined : undefined;
            if (!action) return;
            event.preventDefault(); event.stopPropagation(); act(action);
        };
        const native = (event: ClipboardEvent) => {
            if (event.defaultPrevented || editing()) return;
            event.preventDefault(); event.stopPropagation(); act(event.type as Action);
        };
        const receive = ({ data }: MessageEvent<ToWebview>) => {
            if (data.type === "statementResult" && data.id === pending.current) pending.current = undefined;
        };
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerout", out, true);
        window.addEventListener("blur", leave);
        document.addEventListener("keydown", key, true);
        for (const type of ["copy", "cut", "paste"]) document.addEventListener(type, native as EventListener, true);
        window.addEventListener("message", receive);
        return () => {
            document.removeEventListener("pointermove", move, true);
            document.removeEventListener("pointerout", out, true);
            window.removeEventListener("blur", leave);
            document.removeEventListener("keydown", key, true);
            for (const type of ["copy", "cut", "paste"]) document.removeEventListener(type, native as EventListener, true);
            window.removeEventListener("message", receive);
        };
    }, []);
    return <Clipboard.Provider value={{ insert, toggle: () => setInsert(value => !value), act, available: version !== undefined }}>{children}</Clipboard.Provider>;
}

export function ClipboardMode() {
    const actions = useGraphClipboard();
    return <button type="button" className="clipboard-mode" aria-pressed={actions.insert}
        title={l10n.t("Insert toggles paste between insertion and replacement")}
        onMouseDown={event => event.preventDefault()} onClick={actions.toggle}>
        {l10n.t(actions.insert ? "Paste: Insert" : "Paste: Replace")}
    </button>;
}
