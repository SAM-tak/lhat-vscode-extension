import type { AstReply } from "../../protocol";
import type { ElkNode, MapOptions } from "../map";

export interface LayoutResult { graph: ElkNode; elapsed: number }
export interface LayoutEngine {
    layout(reply: AstReply, options: MapOptions): Promise<LayoutResult>;
    dispose(): void;
}
interface Job {
    reply: AstReply;
    options: MapOptions;
    resolve: (result: LayoutResult | undefined) => void;
    reject: (error: Error) => void;
}

/** At most one running layout and one (latest) queued snapshot. Resizes and
 * edits cannot build up a queue of obsolete, expensive graph calculations.
 */
export class LayoutClient {
    private engine?: Promise<LayoutEngine>;
    private running = false;
    private disposed = false;
    private current?: Job;
    private queued?: Job;
    constructor(private readonly createEngine: () => Promise<LayoutEngine>) {}

    layout(reply: AstReply, options: MapOptions) {
        let job: Job;
        const promise = new Promise<LayoutResult | undefined>((resolve, reject) => {
            job = { reply, options, resolve, reject };
        });
        if (this.disposed) job!.resolve(undefined);
        else {
            this.queued?.resolve(undefined);
            this.queued = job!;
            void this.pump();
        }
        return { promise, cancel: () => {
            job.resolve(undefined);
            if (this.queued === job) this.queued = undefined;
        } };
    }

    dispose(): void {
        this.disposed = true;
        this.current?.resolve(undefined); this.queued?.resolve(undefined);
        this.current = this.queued = undefined;
        void this.engine?.then(engine => engine.dispose(), () => {});
    }

    private async pump(): Promise<void> {
        if (this.running || !this.queued || this.disposed) return;
        this.running = true;
        try {
            this.engine ??= this.createEngine();
            const engine = await this.engine;
            if (this.disposed) return;
            this.current = this.queued; this.queued = undefined;
            const job = this.current;
            if (job) job.resolve(await engine.layout(job.reply, job.options));
        } catch (reason) {
            const error = reason instanceof Error ? reason : new Error(String(reason));
            if (this.current) this.current.reject(error);
            else { this.queued?.reject(error); this.queued = undefined; }
            void this.engine?.then(engine => engine.dispose(), () => {});
            this.engine = undefined;
        } finally {
            this.current = undefined; this.running = false;
            void this.pump();
        }
    }
}
