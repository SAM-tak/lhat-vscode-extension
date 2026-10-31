import React, { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MiniMap, MiniMapNode, type MiniMapNodeProps, type MiniMapProps } from "@xyflow/react";

const ErrorLayer = createContext<SVGGElement | null>(null);

function DiagnosticMiniMapNode(props: MiniMapNodeProps) {
    const layer = useContext(ErrorLayer);
    const error = props.className?.split(" ").includes("minimap-error");
    return <>
        <MiniMapNode {...props} />
        {layer && error && createPortal(<rect className="minimap-error-node" data-node-id={props.id}
            x={props.x} y={props.y} width={props.width} height={props.height}
            rx={props.borderRadius} ry={props.borderRadius} vectorEffect="non-scaling-stroke" />, layer)}
    </>;
}

/** Paint errors after ordinary nodes and the viewport mask, using the same SVG coordinates. */
export function DiagnosticMiniMap(props: MiniMapProps) {
    const wrapper = useRef<HTMLDivElement>(null);
    const [layer, setLayer] = useState<SVGGElement | null>(null);
    useLayoutEffect(() => {
        const svg = wrapper.current?.querySelector(".react-flow__minimap-svg");
        if (!svg) return;
        const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
        group.classList.add("minimap-error-layer");
        group.setAttribute("pointer-events", "none");
        svg.appendChild(group);
        setLayer(group);
        return () => { group.remove(); };
    }, []);
    return <div ref={wrapper} className="diagnostic-minimap">
        <ErrorLayer.Provider value={layer}><MiniMap {...props} nodeComponent={DiagnosticMiniMapNode} /></ErrorLayer.Provider>
    </div>;
}
