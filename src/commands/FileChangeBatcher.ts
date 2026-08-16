export type FileChangeType = 'upsert' | 'unlink';

export interface FileChange {
    filename: string;
    type: FileChangeType;
}

/** Collapse file-system bursts and process each resulting batch serially. */
export class FileChangeBatcher {
    private readonly pending = new Map<string, FileChangeType>();
    private timer?: NodeJS.Timeout;
    private processing: Promise<void> = Promise.resolve();
    private closed = false;

    constructor(
        private readonly handler: (changes: readonly FileChange[]) => Promise<void>,
        private readonly delayMs = 100,
    ) {}

    public enqueue(filename: string, type: FileChangeType): void {
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

    public async flush(): Promise<void> {
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

    public async close(): Promise<void> {
        this.closed = true;
        await this.flush();
    }
}
