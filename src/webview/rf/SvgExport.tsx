import React, { useEffect, useRef, useState } from "react";
import * as l10n from "@vscode/l10n";
import type { FromWebview, ToWebview } from "../../protocol";
import { graphSvg } from "./svgSnapshot";

let sequence = 0;
export function SvgExport({ flow, disabled, title, post }: {
    flow: React.RefObject<HTMLDivElement | null>; disabled: boolean; title: string; post: (message: FromWebview) => void;
}) {
    const [open, setOpen] = useState(false), [background, setBackground] = useState(true), [controls, setControls] = useState(false);
    const [pending, setPending] = useState<string>(), [error, setError] = useState("");
    const container = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        const receive = (event: MessageEvent<ToWebview>) => {
            if (event.data.type !== "svgResult" || event.data.id !== pending) return;
            setPending(undefined);
            if (event.data.error) setError(event.data.error);
            else { setOpen(false); button.current?.focus(); }
        };
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
    }, [pending]);
    useEffect(() => {
        if (!open || pending) return;
        const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
        document.addEventListener("pointerdown", outside, true);
        return () => document.removeEventListener("pointerdown", outside, true);
    }, [open, pending]);
    const save = async () => {
        if (!flow.current || pending) return;
        const id = `svg-${++sequence}`; setPending(id); setError("");
        try {
            await document.fonts.ready;
            // Include the latest input blur/layout and React Flow edge positions.
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            if (!flow.current) { setPending(undefined); return; }
            const svg = graphSvg(flow.current, { background, controls, title });
            post({ type: "saveSvg", id, svg });
        } catch (reason) {
            setPending(undefined);
            setError(l10n.t("SVG export failed: {0}", reason instanceof Error ? reason.message : String(reason)));
        }
    };
    return <div className="svg-export" ref={container} onKeyDown={event => {
        if (event.key === "Escape" && !pending) { event.stopPropagation(); setOpen(false); button.current?.focus(); }
    }}>
        <button type="button" ref={button} disabled={disabled || !!pending} aria-expanded={open}
            title={l10n.t("Export graph as editable SVG")} onClick={() => { setOpen(!open); setError(""); }}>SVG…</button>
        {open && <div className="svg-export-menu" role="dialog" aria-label={l10n.t("Export graph as editable SVG")}>
            <p>{l10n.t("Export the entire current graph, including nodes outside the viewport.")}</p>
            <label><input type="checkbox" checked={background} disabled={!!pending} onChange={event => setBackground(event.target.checked)} />{l10n.t("Include background")}</label>
            <label><input type="checkbox" checked={controls} disabled={!!pending} onChange={event => setControls(event.target.checked)} />{l10n.t("Include editing controls")}</label>
            <button type="button" disabled={disabled || !!pending} onClick={() => void save()}>{pending ? l10n.t("Exporting…") : l10n.t("Save SVG")}</button>
            {error && <p className="svg-export-error" role="alert">{error}</p>}
        </div>}
    </div>;
}
