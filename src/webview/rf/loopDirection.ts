/** Small filled triangles along a loop's return route, with shared spacing across segments.
 * Leave rounded corners and endpoints clear of direction marks. */
export function loopDirectionArrows(points: readonly (readonly [number, number])[], scale: number): string {
    const spacing = 96 * scale, size = 3 * scale, clearance = 9 * scale;
    let travelled = 0, next = spacing / 2;
    const arrows: string[] = [];
    for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i - 1], [endX, endY] = points[i];
        const length = Math.hypot(endX - x, endY - y);
        if (!length) continue;
        const dx = (endX - x) / length, dy = (endY - y) / length;
        while (next < travelled + length) {
            const offset = next - travelled;
            if (offset >= clearance && length - offset >= clearance) {
                const tipX = x + dx * offset, tipY = y + dy * offset;
                const backX = tipX - dx * size * 1.5, backY = tipY - dy * size * 1.5;
                arrows.push(`M ${backX - dy * size} ${backY + dx * size} L ${tipX} ${tipY} L ${backX + dy * size} ${backY - dx * size} Z`);
            }
            next += spacing;
        }
        travelled += length;
    }
    return arrows.join(" ");
}
