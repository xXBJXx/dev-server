import { HIDDEN_BROWSER_SYNC_PORT_OFFSET } from './CommandBase.js';
import { RunCommandBase } from './RunCommandBase.js';
export class Run extends RunCommandBase {
    useBrowserSync;
    constructor(owner, useBrowserSync) {
        super(owner);
        this.useBrowserSync = useBrowserSync;
    }
    async doRun() {
        await this.startJsController();
        await this.startServer(this.useBrowserSync);
    }
    getStartupPorts() {
        const ports = super.getStartupPorts();
        if (this.useBrowserSync) {
            ports.push({ name: 'Live reload', port: this.getPort(HIDDEN_BROWSER_SYNC_PORT_OFFSET) });
        }
        return ports;
    }
}
