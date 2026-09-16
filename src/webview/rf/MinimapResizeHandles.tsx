import React, { useRef } from "react";
import { MIN_MINIMAP_SIZE, resizeMinimap, type MinimapResizeEdge, type MinimapSize } from "../minimap";

export function MinimapResizeHandles({ size, preferredSize, available, onResize }: {
    size: MinimapSize;
    preferredSize: MinimapSize;
    available: MinimapSize;
    onResize: (size: MinimapSize) => void;
}) {
    const drag = useRef<{
        pointer: number; edge: MinimapResizeEdge; position: number;
        size: MinimapSize; preferred: MinimapSize;
    } | null>(null);
    const dimension = (edge: MinimapResizeEdge) => edge === "left" ? "width" : "height";
    const update = (start: MinimapSize, preferred: MinimapSize, edge: MinimapResizeEdge, delta: number) => {
        const key = dimension(edge);
        // Resizing one edge must not overwrite the other axis's preference
        // just because it happens to be clamped by a small editor pane.
        onResize({ ...preferred, [key]: resizeMinimap(start, edge, delta, available)[key] });
    };
    return <>{(["left", "top"] as const).map((edge) => {
        const key = dimension(edge);
        return <div key={edge} className={`minimap-resize minimap-resize-${edge} nodrag nopan nowheel`}
            role="separator" tabIndex={0}
            aria-label={`Resize minimap ${key}`}
            aria-orientation={edge === "left" ? "vertical" : "horizontal"}
            aria-valuenow={Math.round(size[key])}
            aria-valuemin={Math.min(MIN_MINIMAP_SIZE, available[key])}
            aria-valuemax={available[key]}
            title={`Drag to resize minimap ${key} (${edge === "left" ? "← / →" : "↑ / ↓"})`}
            onPointerDown={(event) => {
                if (event.button !== 0 || !event.isPrimary) return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.focus({ preventScroll: true });
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { pointer: event.pointerId, edge,
                    position: edge === "left" ? event.clientX : event.clientY,
                    size, preferred: preferredSize };
            }}
            onPointerMove={(event) => {
                const current = drag.current;
                if (current?.pointer !== event.pointerId) return;
                event.stopPropagation();
                const position = current.edge === "left" ? event.clientX : event.clientY;
                update(current.size, current.preferred, current.edge, position - current.position);
            }}
            onPointerUp={(event) => {
                if (drag.current?.pointer !== event.pointerId) return;
                event.stopPropagation();
                drag.current = null;
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={(event) => {
                if (drag.current?.pointer !== event.pointerId) return;
                onResize(drag.current.preferred);
                drag.current = null;
            }}
            onLostPointerCapture={() => { drag.current = null; }}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape" && drag.current !== null) {
                    event.preventDefault();
                    const current = drag.current;
                    drag.current = null;
                    onResize(current.preferred);
                    event.currentTarget.releasePointerCapture(current.pointer);
                    return;
                }
                if (drag.current !== null) return;
                const decrease = edge === "left" ? "ArrowRight" : "ArrowDown";
                const increase = edge === "left" ? "ArrowLeft" : "ArrowUp";
                if (event.key !== decrease && event.key !== increase) return;
                event.preventDefault();
                update(size, preferredSize, edge, (event.key === decrease ? 1 : -1) * (event.shiftKey ? 20 : 4));
            }} />;
    })}</>;
}
