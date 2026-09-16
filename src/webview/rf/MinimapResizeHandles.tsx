import React, { useRef } from "react";
import { MIN_MINIMAP_SIZE, resizeMinimap, type MinimapResizeEdge, type MinimapResizeDelta, type MinimapSize } from "../minimap";

export function MinimapResizeHandles({ size, preferredSize, available, onResize }: {
    size: MinimapSize;
    preferredSize: MinimapSize;
    available: MinimapSize;
    onResize: (size: MinimapSize) => void;
}) {
    const drag = useRef<{
        pointer: number; edge: MinimapResizeEdge; position: MinimapResizeDelta;
        size: MinimapSize; preferred: MinimapSize;
    } | null>(null);
    const update = (start: MinimapSize, preferred: MinimapSize, edge: MinimapResizeEdge, delta: MinimapResizeDelta) => {
        const next = resizeMinimap(start, edge, delta, available);
        // Resizing one edge must not overwrite the other axis's preference
        // just because it happens to be clamped by a small editor pane.
        onResize({ width: edge === "top" ? preferred.width : next.width,
            height: edge === "left" ? preferred.height : next.height });
    };
    return <>{(["left", "top", "top-left"] as const).map((edge) => {
        const corner = edge === "top-left";
        const key = edge === "left" ? "width" : "height";
        return <div key={edge} className={`minimap-resize minimap-resize-${edge} nodrag nopan nowheel`}
            tabIndex={0}
            {...(corner ? {
                role: "group", "aria-roledescription": "resize handle",
                "aria-label": `Resize minimap width and height (${Math.round(size.width)} by ${Math.round(size.height)} pixels)`,
            } : {
                role: "separator", "aria-label": `Resize minimap ${key}`,
                "aria-orientation": edge === "left" ? "vertical" as const : "horizontal" as const,
                "aria-valuenow": Math.round(size[key]),
                "aria-valuemin": Math.min(MIN_MINIMAP_SIZE, available[key]),
                "aria-valuemax": available[key],
            })}
            title={`Drag to resize minimap ${corner ? "width and height (← / → / ↑ / ↓)" : `${key} (${edge === "left" ? "← / →" : "↑ / ↓"})`}`}
            onPointerDown={(event) => {
                if (event.button !== 0 || !event.isPrimary) return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.focus({ preventScroll: true });
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { pointer: event.pointerId, edge,
                    position: { x: event.clientX, y: event.clientY },
                    size, preferred: preferredSize };
            }}
            onPointerMove={(event) => {
                const current = drag.current;
                if (current?.pointer !== event.pointerId) return;
                event.stopPropagation();
                update(current.size, current.preferred, current.edge, {
                    x: event.clientX - current.position.x, y: event.clientY - current.position.y,
                });
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
                const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
                const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
                if ((!horizontal && !vertical) || (edge === "left" && !horizontal) || (edge === "top" && !vertical)) return;
                event.preventDefault();
                const delta = (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) * (event.shiftKey ? 20 : 4);
                update(size, preferredSize, horizontal ? "left" : "top", {
                    x: horizontal ? delta : 0, y: vertical ? delta : 0,
                });
            }} />;
    })}</>;
}
