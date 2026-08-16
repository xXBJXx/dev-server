/** Collapse file-system bursts and process each resulting batch serially. */
export class FileChangeBatcher {
    handler;
    delayMs;
    pending = new Map();
    timer;
    processing = Promise.resolve();
    closed = false;
    constructor(handler, delayMs = 100) {
        this.handler = handler;
        this.delayMs = delayMs;
    }
    enqueue(filename, type) {
        if (this.closed) {
            return;
        }
        // Only the final state of a file within one editor/build burst matters.
        this.pending.set(filename, type);
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush();
        }, this.delayMs);
    }
    async flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        if (!this.pending.size) {
            return this.processing;
        }
        const changes = [...this.pending].map(([filename, type]) => ({ filename, type }));
        this.pending.clear();
        const previous = this.processing.catch(() => undefined);
        this.processing = previous.then(async () => await this.handler(changes));
        return this.processing;
    }
    async close() {
        this.closed = true;
        await this.flush();
    }
}
