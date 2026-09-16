import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import * as l10n from "@vscode/l10n";
import type { FromWebview, ToWebview, TypeSite } from "../../protocol";

const Types = createContext<{ version?: number; post: (message: FromWebview) => void }>({ post: () => {} });
export const TypeProvider = Types.Provider;
let sequence = 0;

/** One visual language for literal types, binding types and member types. */
export function TypeLabel({ label, site }: { label: string; site?: TypeSite }) {
    const context = useContext(Types);
    const [error, setError] = useState("");
    const [pending, setPending] = useState(false);
    const request = useRef<string | undefined>(undefined);
    useEffect(() => { request.current = undefined; setPending(false); setError(""); },
        [context.version, site?.start, site?.end, site?.typeText]);
    useEffect(() => {
        if (!site) return;
        const receive = (event: MessageEvent<ToWebview>) => {
            if (event.data.type !== "typeResult" || event.data.id !== request.current) return;
            request.current = undefined;
            setPending(false); setError(event.data.error ?? "");
        };
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
    }, [!!site]);
    const origin = site?.explicit ? l10n.t("Explicit type annotation") : l10n.t("Inferred type");
    const className = `type-label semantic-label ${site?.explicit ? "type-explicit" : "type-inferred"}`;
    if (!site) return <span className={className} data-category="type" title={origin}>{label}</span>;
    return <button type="button" className={`${className} nodrag nopan nowheel nokey`}
        data-category="type" aria-label={l10n.t("{0}: {1}. Choose type", site.name, label)}
        aria-busy={pending} aria-invalid={!!error} disabled={pending || context.version === undefined}
        title={error || `${origin}: ${site.typeText}\n${l10n.t("Click to choose a type")}`}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
        onClick={event => {
            event.stopPropagation();
            if (context.version === undefined) return;
            request.current = `type-${++sequence}`; setPending(true); setError("");
            context.post({ type: "chooseType", id: request.current, start: site.start, end: site.end, version: context.version });
        }}>{label}{error && <span role="alert" className="type-error">{error}</span>}</button>;
}
