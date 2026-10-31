import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Delegation keeps diagnostics visible even over controls with their own title. */
export function DiagnosticTooltip({ revision }: { revision: unknown }) {
    const [hover, setHover] = useState<{ x: number; y: number; message: string }>();
    const tip = useRef<HTMLDivElement>(null);
    const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
    const update = () => {
        const point = pointer.current;
        const message = point && document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("[data-graph-error]")?.dataset.graphError;
        setHover(point && message ? { ...point, message } : undefined);
    };
    useEffect(() => {
        const frame = requestAnimationFrame(update);
        return () => cancelAnimationFrame(frame);
    }, [revision]);
    useEffect(() => {
        const move = (event: PointerEvent) => { pointer.current = { x: event.clientX, y: event.clientY }; update(); };
        const hide = () => { pointer.current = undefined; setHover(undefined); };
        const leave = (event: PointerEvent) => { if (!event.relatedTarget) hide(); };
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerout", leave, true);
        document.addEventListener("keydown", hide, true);
        document.addEventListener("scroll", hide, true);
        document.addEventListener("wheel", hide, { capture: true, passive: true });
        document.addEventListener("pointerdown", hide, true);
        window.addEventListener("blur", hide);
        return () => {
            document.removeEventListener("pointermove", move, true);
            document.removeEventListener("pointerout", leave, true);
            document.removeEventListener("keydown", hide, true);
            document.removeEventListener("scroll", hide, true);
            document.removeEventListener("wheel", hide, true);
            document.removeEventListener("pointerdown", hide, true);
            window.removeEventListener("blur", hide);
        };
    }, []);
    useLayoutEffect(() => {
        if (!hover || !tip.current) return;
        const element = tip.current;
        element.style.left = `${Math.max(8, Math.min(hover.x + 12, innerWidth - element.offsetWidth - 8))}px`;
        element.style.top = `${Math.max(8, Math.min(hover.y + 12, innerHeight - element.offsetHeight - 8))}px`;
    }, [hover]);
    return hover && createPortal(<div ref={tip} role="tooltip" className="graph-diagnostic-tooltip">{hover.message}</div>, document.body);
}
