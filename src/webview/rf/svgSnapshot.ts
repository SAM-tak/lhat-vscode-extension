/** Export the rendered graph, sharing its layout, labels and computed theme.
 * HTML is translated to ordinary SVG shapes/text; no foreignObject or bitmap.
 * All React Flow nodes are mounted, including those outside the viewport.
 */
export interface SvgExportOptions { background: boolean; controls: boolean; title: string }
const SVG = "http://www.w3.org/2000/svg";
const INKSCAPE = "http://www.inkscape.org/namespaces/inkscape";
const number = (value: number) => String(Math.round(value * 1000) / 1000);
const px = (value: string) => parseFloat(value) || 0;
const clean = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");

export function graphSvg(flow: HTMLElement, options: SvgExportOptions): string {
    const doc = flow.ownerDocument;
    const style = (element: Element) => doc.defaultView!.getComputedStyle(element);
    const make = (tag: string, attributes: Record<string, string | number> = {}) => {
        const element = doc.createElementNS(SVG, tag);
        for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, typeof value === "number" ? number(value) : value);
        return element;
    };
    const root = make("svg", { version: "1.1" });
    root.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns:inkscape", INKSCAPE);
    const title = make("title"); title.textContent = clean(options.title); root.append(title);
    const defs = make("defs"); root.append(defs);
    let sequence = 0;
    const nextId = () => `lhat-svg-${++sequence}`;
    const label = (element: Element, text: string) => element.setAttributeNS(INKSCAPE, "inkscape:label", clean(text));
    // Chromium can return color(srgb ...) / color-mix results. Resolve these to
    // SVG 1.1 RGB + alpha, without baking any part of the diagram into an image.
    const canvas = doc.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const colors = new Map<string, { color: string; alpha: number }>();
    const color = (css: string) => {
        let result = colors.get(css);
        if (!result) {
            context.clearRect(0, 0, 1, 1); context.fillStyle = css; context.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
            result = { color: `#${[r, g, b].map(n => n.toString(16).padStart(2, "0")).join("")}`, alpha: a / 255 };
            colors.set(css, result);
        }
        return result;
    };
    const paint = (element: Element, attribute: "fill" | "stroke", css: string, opacity = 1) => {
        if (!css || css === "none" || css === "transparent") { element.setAttribute(attribute, "none"); return; }
        const resolved = color(css);
        element.setAttribute(attribute, resolved.alpha ? resolved.color : "none");
        if (resolved.alpha * opacity < 1) element.setAttribute(`${attribute}-opacity`, number(resolved.alpha * opacity));
    };
    const opacity = (element: Element, css: CSSStyleDeclaration) => {
        if (css.opacity !== "1") element.setAttribute("opacity", css.opacity);
    };
    const clip = (parent: Element, rect: DOMRect, radius = 0) => {
        const id = nextId(), path = make("clipPath", { id, clipPathUnits: "userSpaceOnUse" });
        path.append(make("rect", { x: rect.x, y: rect.y, width: rect.width, height: rect.height, rx: radius }));
        defs.append(path);
        const group = make("g", { "clip-path": `url(#${id})` }); parent.append(group); return group;
    };
    const markers = new Map<string, string>();
    const geometry = ["d", "points", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
        "width", "height", "viewBox", "transform", "preserveAspectRatio", "refX", "refY", "orient", "markerWidth", "markerHeight", "markerUnits"];
    const cloneVector = (source: Element): Element | undefined => {
        if (!["path", "polygon", "polyline", "line", "circle", "ellipse", "rect", "g", "marker"].includes(source.localName)) return;
        const copy = make(source.localName);
        for (const name of geometry) if (source.hasAttribute(name)) copy.setAttribute(name, source.getAttribute(name)!);
        const css = style(source);
        paint(copy, "fill", css.fill, Number(css.fillOpacity));
        paint(copy, "stroke", css.stroke, Number(css.strokeOpacity));
        for (const name of ["stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "fill-rule", "vector-effect"]) {
            copy.setAttribute(name, css.getPropertyValue(name));
        }
        opacity(copy, css);
        for (const end of ["marker-start", "marker-end"]) {
            const url = css.getPropertyValue(end).match(/^url\(["']?(.*?)["']?\)$/)?.[1];
            const reference = url?.includes("#") ? url.slice(url.indexOf("#") + 1) : undefined;
            if (!reference) continue;
            let id = markers.get(reference);
            if (!id) {
                const original = doc.getElementById(decodeURIComponent(reference));
                const marker = original && cloneVector(original);
                if (!marker) continue;
                id = nextId(); marker.setAttribute("id", id); markers.set(reference, id); defs.append(marker);
            }
            copy.setAttribute(end, `url(#${id})`);
        }
        for (const child of source.children) { const cloned = cloneVector(child); if (cloned) copy.append(cloned); }
        return copy;
    };
    const vector = (source: SVGGraphicsElement, parent: Element) => {
        const matrix = source.getScreenCTM();
        if (!matrix) return;
        const group = make("g", { transform: `matrix(${[matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].map(number).join(" ")})` });
        if (source.localName === "svg") {
            opacity(group, style(source));
            for (const child of source.children) { const cloned = cloneVector(child); if (cloned) group.append(cloned); }
        } else {
            const cloned = cloneVector(source);
            if (cloned) { cloned.removeAttribute("transform"); group.append(cloned); }
        }
        parent.append(group);
    };
    const fontMetrics = (css: CSSStyleDeclaration) => {
        context.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
        const metrics = context.measureText("Mg");
        return { ascent: metrics.fontBoundingBoxAscent, descent: metrics.fontBoundingBoxDescent };
    };
    const text = (value: string, x: number, y: number, css: CSSStyleDeclaration, parent: Element) => {
        if (!value) return;
        const element = make("text", { x, y, "font-family": css.fontFamily, "font-size": css.fontSize,
            "font-style": css.fontStyle, "font-weight": css.fontWeight, "letter-spacing": css.letterSpacing });
        element.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
        paint(element, "fill", css.color); element.textContent = clean(value); parent.append(element);
        if (css.textDecorationLine.includes("underline")) {
            context.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
            const line = make("path", { d: `M ${number(x)} ${number(y + (px(css.textUnderlineOffset) || 2))} h ${number(context.measureText(value).width)}`,
                "stroke-width": 0.7, fill: "none" });
            paint(line, "stroke", css.textDecorationColor);
            if (css.textDecorationStyle === "dotted") line.setAttribute("stroke-dasharray", "1 1");
            parent.append(line);
        }
    };
    const textNode = (source: Text, parent: Element) => {
        if (!source.textContent) return;
        const css = style(source.parentElement!), range = doc.createRange(); range.selectNodeContents(source);
        const rects = [...range.getClientRects()];
        if (!rects.length) return;
        const { descent } = fontMetrics(css);
        if (rects.length === 1) {
            const value = /pre|break-spaces/.test(css.whiteSpace) ? source.data : source.data.replace(/\s+/g, " ");
            text(value, rects[0].left, rects[0].bottom - descent, css, parent);
        } else {
            // Rare wrapped captions: keep one editable text run per visual line.
            let offset = 0, line = "", previous: DOMRect | undefined;
            for (const char of source.data) {
                range.setStart(source, offset); offset += char.length; range.setEnd(source, offset);
                const rect = range.getBoundingClientRect();
                if (previous && Math.abs(rect.top - previous.top) > 1) {
                    text(line, previous.left, previous.bottom - descent, css, parent); line = ""; previous = undefined;
                }
                previous ??= rect; line += char;
            }
            if (previous) text(line, previous.left, previous.bottom - descent, css, parent);
        }
    };
    const border = (shape: Element, css: CSSStyleDeclaration) => {
        paint(shape, "stroke", css.borderTopStyle === "none" ? "none" : css.borderTopColor);
        shape.setAttribute("stroke-width", css.borderTopWidth);
        if (css.borderTopStyle === "dashed") shape.setAttribute("stroke-dasharray", "4 3");
        if (css.borderTopStyle === "dotted") shape.setAttribute("stroke-dasharray", "1 2");
    };
    const draw = (source: Element, parent: Element): void => {
        if (source.matches(".react-flow__handle, .node-reorder") ||
            (!options.controls && source.matches(".foldbtn, .statement-button, .add-node"))) return;
        const css = style(source), rect = source.getBoundingClientRect();
        if (css.display === "none" || css.visibility === "hidden" || css.opacity === "0") return;
        if (source instanceof SVGGraphicsElement) { vector(source, parent); return; }
        const group = make("g"); opacity(group, css); parent.append(group);
        const stroke = px(css.borderTopWidth), radiusText = css.borderTopLeftRadius;
        const radius = radiusText.endsWith("%") ? Math.min(rect.width, rect.height) * px(radiusText) / 100 : px(radiusText);
        if (source.matches("fieldset.io-frame")) {
            const legend = source.querySelector("legend")!.getBoundingClientRect();
            const x = rect.left + stroke / 2, y = legend.top + legend.height / 2;
            const right = rect.right - stroke / 2, bottom = rect.bottom - stroke / 2;
            const r = Math.min(radius, rect.width / 2, (bottom - y) / 2);
            const frame = make("path", { fill: "none", d: `M ${number(legend.right)} ${number(y)} H ${number(right - r)} Q ${number(right)} ${number(y)} ${number(right)} ${number(y + r)} V ${number(bottom - r)} Q ${number(right)} ${number(bottom)} ${number(right - r)} ${number(bottom)} H ${number(x + r)} Q ${number(x)} ${number(bottom)} ${number(x)} ${number(bottom - r)} V ${number(y + r)} Q ${number(x)} ${number(y)} ${number(x + r)} ${number(y)} H ${number(legend.left)}` });
            border(frame, css); group.append(frame);
        } else if (rect.width && rect.height && (color(css.backgroundColor).alpha || stroke)) {
            const box = make("rect", { x: rect.left + stroke / 2, y: rect.top + stroke / 2,
                width: Math.max(0, rect.width - stroke), height: Math.max(0, rect.height - stroke), rx: Math.max(0, radius - stroke / 2) });
            paint(box, "fill", css.backgroundColor); border(box, css); group.append(box);
        }
        let content: Element = group;
        if (["hidden", "auto", "scroll"].includes(css.overflowX) || ["hidden", "auto", "scroll"].includes(css.overflowY)) content = clip(group, rect, radius);
        if (source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement) {
            const left = rect.left + px(css.borderLeftWidth) + px(css.paddingLeft);
            const top = rect.top + px(css.borderTopWidth) + px(css.paddingTop);
            const width = source.clientWidth - px(css.paddingLeft) - px(css.paddingRight);
            const height = source.clientHeight - px(css.paddingTop) - px(css.paddingBottom);
            const { ascent, descent } = fontMetrics(css), lineHeight = px(css.lineHeight) || ascent + descent;
            const input = clip(content, new DOMRect(left, top, width, height));
            const baseline = top + (source instanceof HTMLInputElement ? height : lineHeight) / 2 + (ascent - descent) / 2;
            source.value.split(/\r?\n/).forEach((line, i) => {
                context.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
                const shift = css.textAlign === "center" ? (width - context.measureText(line).width) / 2
                    : ["right", "end"].includes(css.textAlign) ? width - context.measureText(line).width : 0;
                text(line, left + shift - source.scrollLeft, baseline + i * lineHeight - source.scrollTop, css, input);
            });
            return;
        }
        for (const child of source.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) textNode(child as Text, content);
            else if (child instanceof Element) draw(child, content);
        }
    };

    const parts: { element: Element; z: number; order: number }[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const bounds = (rect: DOMRect) => { minX = Math.min(minX, rect.left); minY = Math.min(minY, rect.top); maxX = Math.max(maxX, rect.right); maxY = Math.max(maxY, rect.bottom); };
    for (const node of flow.querySelectorAll<HTMLElement>(".react-flow__node")) {
        if (style(node).visibility === "hidden" || (!options.controls && node.querySelector(".add-node"))) continue;
        const group = make("g", { id: nextId(), "data-node-id": node.dataset.id ?? "" });
        const caption = node.querySelector(".boxlabel, legend, .operator-cell")?.textContent
            ?? node.querySelector<HTMLInputElement>("input")?.value ?? node.getAttribute("aria-label") ?? "Node";
        label(group, caption);
        for (const child of node.children) draw(child, group);
        if (!group.querySelector("rect, path, text, circle, polygon")) continue;
        bounds(node.getBoundingClientRect());
        if (options.controls) for (const button of node.querySelectorAll(".statement-button, .foldbtn")) bounds(button.getBoundingClientRect());
        parts.push({ element: group, z: px(style(node).zIndex), order: parts.length });
    }
    for (const edge of flow.querySelectorAll<SVGGraphicsElement>(".react-flow__edge")) {
        const group = make("g", { id: nextId(), "data-edge-id": edge.dataset.id ?? "" }); label(group, "Connection");
        for (const path of edge.querySelectorAll<SVGGraphicsElement>(".react-flow__edge-path")) { vector(path, group); bounds(path.getBoundingClientRect()); }
        if (group.childElementCount) parts.push({ element: group, z: px(style(edge.closest("svg")!).zIndex), order: parts.length });
    }
    if (!Number.isFinite(minX)) throw new Error("The graph has no rendered nodes.");
    const padding = 20, x = minX - padding, y = minY - padding, width = maxX - minX + 2 * padding, height = maxY - minY + 2 * padding;
    root.setAttribute("viewBox", [x, y, width, height].map(number).join(" "));
    root.setAttribute("width", number(width)); root.setAttribute("height", number(height));
    if (options.background) {
        const background = make("g", { id: "background" }); label(background, "Background");
        const rect = make("rect", { x, y, width, height });
        paint(rect, "fill", style(flow.querySelector(".react-flow__background") ?? flow).backgroundColor); background.append(rect);
        const sourcePattern = flow.querySelector(".react-flow__background pattern");
        if (sourcePattern) {
            const id = nextId(), pattern = make("pattern", { id, patternUnits: "userSpaceOnUse" });
            for (const key of ["width", "height", "patternTransform"]) if (sourcePattern.hasAttribute(key)) pattern.setAttribute(key, sourcePattern.getAttribute(key)!);
            const origin = sourcePattern.closest("svg")!.getBoundingClientRect();
            pattern.setAttribute("x", number(origin.left + px(sourcePattern.getAttribute("x") ?? "0")));
            pattern.setAttribute("y", number(origin.top + px(sourcePattern.getAttribute("y") ?? "0")));
            for (const child of sourcePattern.children) { const cloned = cloneVector(child); if (cloned) pattern.append(cloned); }
            defs.append(pattern); background.append(make("rect", { x, y, width, height, fill: `url(#${id})` }));
        }
        root.append(background);
    }
    parts.sort((a, b) => a.z - b.z || a.order - b.order).forEach(part => root.append(part.element));
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(root)}\n`;
}
