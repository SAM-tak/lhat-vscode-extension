import type { ElkNode } from "./map";

/** The visible box that supplies a value. Undefined means no single output. */
export function definitionSource(node: ElkNode): string | undefined {
    const outputs = node.lhat?.definitionOutputs;
    return outputs === undefined ? node.id : outputs.length === 1 ? outputs[0] : undefined;
}
