import type { DevServer } from '../DevServer.js';
import { HIDDEN_BROWSER_SYNC_PORT_OFFSET } from './CommandBase.js';
import type { PortDefinition } from './portDiagnostics.js';
import { RunCommandBase } from './RunCommandBase.js';

export class Run extends RunCommandBase {
    constructor(
        owner: DevServer,
        private readonly useBrowserSync: boolean,
    ) {
        super(owner);
    }

    protected async doRun(): Promise<void> {
        await this.startJsController();
        await this.startServer(this.useBrowserSync);
    }

    protected override getStartupPorts(): PortDefinition[] {
        const ports = super.getStartupPorts();
        if (this.useBrowserSync) {
            ports.push({ name: 'BrowserSync', port: this.getPort(HIDDEN_BROWSER_SYNC_PORT_OFFSET) });
        }
        return ports;
    }
}
