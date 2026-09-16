import React, { useEffect, useRef } from "react";
import type { FromWebview, ReferenceTarget, SourceSpan, ToWebview } from "../../protocol";
import { referencePath } from "../reference";

const selector = "[data-reference-start][data-reference-end]";
const keyOf = (span: SourceSpan) => `${span.start}:${span.end}`;
let requestId = 0;

/** Hover-only decoration. DOM anchors follow layout, font size and partial scrolling. */
export function ReferenceLine({ flow, source, version, post }: {
    flow: React.RefObject<HTMLDivElement | null>;
    source: string;
    version?: number;
    post: (message: FromWebview) => void;
}) {
    const pathRef = useRef<SVGPathElement>(null);
    useEffect(() => {
        const area = flow.current, path = pathRef.current;
        if (!area || !path || version === undefined) return;
        const cache = new Map<string, ReferenceTarget | undefined>();
        let hover: { span: SourceSpan; element: HTMLElement; id?: string } | undefined;
        let target: ReferenceTarget | undefined;
        let timer: number | undefined, frame: number | undefined;
        let pointer = { x: 0, y: 0 };
        const hide = () => path.removeAttribute("d");
        const clear = () => {
            window.clearTimeout(timer);
            if (frame !== undefined) cancelAnimationFrame(frame);
            frame = undefined; hover = undefined; target = undefined;
            hide();
        };
        const anchorAt = (element: Element | null): HTMLElement | null => {
            if (!element || element.closest(".disabled, .foldbtn, .react-flow__handle, .literal-editor")) return null;
            const anchor = element.closest<HTMLElement>(selector);
            if (!anchor || !area.contains(anchor)) return null;
            // A one-name leaf is a generous hover target, including its padding.
            const box = anchor.closest<HTMLElement>(`.box${selector}`);
            return box ?? anchor;
        };
        const endpoint = (value: ReferenceTarget): HTMLElement | undefined => {
            const attr = value.box ? "source" : "reference";
            const elements = [...area.querySelectorAll<HTMLElement>(
                `[data-${attr}-start="${value.start}"][data-${attr}-end="${value.end}"]`)]
                .filter(element => !element.closest(".disabled"));
            // Prefer the exact name inside a title/input over the surrounding leaf.
            return elements.find(element => !element.classList.contains("box")) ?? elements[0];
        };
        const relativeRect = (element: HTMLElement, bounds: DOMRect) => {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || rect.right <= bounds.left || rect.left >= bounds.right ||
                rect.bottom <= bounds.top || rect.top >= bounds.bottom) return undefined;
            // Clipped/truncated labels must not acquire an invisible endpoint.
            const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
            if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return undefined;
            if (!element.contains(document.elementFromPoint(x, y))) return undefined;
            return { left: rect.left - bounds.left, top: rect.top - bounds.top,
                right: rect.right - bounds.left, bottom: rect.bottom - bounds.top };
        };
        const paint = () => {
            frame = undefined;
            if (!hover || !target) return;
            if (!hover.element.isConnected || anchorAt(document.elementFromPoint(pointer.x, pointer.y)) !== hover.element) {
                clear(); return;
            }
            const end = endpoint(target), bounds = area.getBoundingClientRect();
            const from = relativeRect(hover.element, bounds);
            const to = end && relativeRect(end, bounds);
            if (from && to && end !== hover.element) path.setAttribute("d", referencePath(from, to));
            else hide();
            frame = requestAnimationFrame(paint);
        };
        const show = (answer: ReferenceTarget | undefined) => {
            target = answer;
            if (answer) paint();
        };
        const move = (event: PointerEvent) => {
            pointer = { x: event.clientX, y: event.clientY };
            if (event.buttons || event.pointerType === "touch") { clear(); return; }
            const element = anchorAt(event.target instanceof Element ? event.target : null);
            if (element === hover?.element) return;
            clear();
            if (!element) return;
            const span = { start: Number(element.dataset.referenceStart), end: Number(element.dataset.referenceEnd) };
            if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 ||
                span.end <= span.start || span.end > source.length) return;
            hover = { span, element };
            const key = keyOf(span);
            if (cache.has(key)) { show(cache.get(key)); return; }
            timer = window.setTimeout(() => {
                if (!hover || hover.element !== element) return;
                const id = `reference-${++requestId}`;
                hover.id = id;
                post({ type: "reference", id, ...span, text: source.slice(span.start, span.end), version });
            }, 90);
        };
        const receive = (event: MessageEvent<ToWebview>) => {
            const message = event.data;
            if (message.type === "tree" || message.type === "pending" || message.type === "error") {
                clear(); cache.clear(); return;
            }
            if (message.type !== "referenceResult" || message.version !== version || !hover || message.id !== hover.id) return;
            hover.id = undefined;
            if (cache.size >= 512) cache.clear();
            cache.set(keyOf(hover.span), message.target);
            show(message.target);
        };
        area.addEventListener("pointermove", move, true);
        area.addEventListener("pointerleave", clear);
        area.addEventListener("pointerdown", clear, true);
        window.addEventListener("blur", clear);
        window.addEventListener("message", receive);
        return () => {
            clear();
            area.removeEventListener("pointermove", move, true);
            area.removeEventListener("pointerleave", clear);
            area.removeEventListener("pointerdown", clear, true);
            window.removeEventListener("blur", clear);
            window.removeEventListener("message", receive);
        };
    }, [flow, source, version, post]);
    return <svg className="reference-overlay" aria-hidden="true"><path ref={pathRef} className="reference-line" /></svg>;
}
