import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { satisfies } from 'semver';
import type { DevServer } from '../DevServer.js';
import {
    HIDDEN_ADMIN_PORT_OFFSET,
    HIDDEN_BROWSER_SYNC_PORT_OFFSET,
    OBJECTS_DB_PORT_OFFSET,
    STATES_DB_PORT_OFFSET,
} from './CommandBase.js';
import { getNestedFrontendDirectories, getNestedFrontendWatchCommand } from './frontendWatch.js';
import { getWindowsPortOwners, isPortListening } from './portDiagnostics.js';
import { readJson } from './utils.js';

const CONTROLLER_DEBUGGER_PORT = 9228;
const ADAPTER_DEBUGGER_PORT = 9229;

export { parseWindowsListeningPorts } from './portDiagnostics.js';

export type DiagnosticStatus = 'ok' | 'warning' | 'error';

export interface DiagnosticResult {
    check: string;
    status: DiagnosticStatus;
    detail: string;
}

export class Doctor {
    constructor(private readonly owner: DevServer) {}

    public async run(json = false): Promise<void> {
        const results = await this.diagnose();
        if (json) {
            console.log(JSON.stringify({ profile: this.owner.profileName, results }, null, 2));
            return;
        }

        this.owner.log.info(`dev-server diagnostics for profile "${this.owner.profileName}"`);
        this.owner.log.table([
            ['Status', 'Check', 'Details'],
            ...results.map(result => [this.formatStatus(result.status), result.check, result.detail]),
        ]);

        const errors = results.filter(result => result.status === 'error').length;
        const warnings = results.filter(result => result.status === 'warning').length;
        if (errors === 0 && warnings === 0) {
            this.owner.log.box('All diagnostics passed.');
        } else {
            this.owner.log.info(`Summary: ${errors} error(s), ${warnings} warning(s), ${results.length} checks.`);
        }
    }

    public async diagnose(): Promise<DiagnosticResult[]> {
        const results: DiagnosticResult[] = [];
        await this.checkRuntime(results);
        this.checkAdapter(results);
        this.checkProfile(results);
        await this.checkPorts(results);
        await this.checkLocks(results);
        await this.checkFrontend(results);
        return results;
    }

    private async checkRuntime(results: DiagnosticResult[]): Promise<void> {
        const ownPackage = await this.owner.readMyPackageJson();
        const engine = ownPackage.engines?.node as string | undefined;
        const supported = !engine || satisfies(process.versions.node, engine);
        results.push({
            check: 'Node.js',
            status: supported ? 'ok' : 'error',
            detail: `${process.version}${engine ? ` (required: ${engine})` : ''}`,
        });
        results.push({
            check: 'Platform',
            status: 'ok',
            detail: `${process.platform} ${process.arch}`,
        });
    }

    private checkAdapter(results: DiagnosticResult[]): void {
        const ioPackagePath = path.join(this.owner.rootPath, 'io-package.json');
        const packagePath = path.join(this.owner.rootPath, 'package.json');
        results.push({
            check: 'Adapter metadata',
            status: existsSync(ioPackagePath) && existsSync(packagePath) ? 'ok' : 'error',
            detail:
                existsSync(ioPackagePath) && existsSync(packagePath)
                    ? this.owner.adapterName
                    : 'Missing package.json or io-package.json',
        });
    }

    private checkProfile(results: DiagnosticResult[]): void {
        if (!this.owner.config) {
            results.push({
                check: 'Profile setup',
                status: 'error',
                detail: `Profile directory is not configured: ${this.owner.profilePath}`,
            });
            return;
        }

        results.push({
            check: 'Profile setup',
            status: this.owner.isSetUp() ? 'ok' : 'error',
            detail: this.owner.config.remote
                ? `remote: ${this.owner.config.remote.user}@${this.owner.config.remote.host}`
                : this.owner.profilePath,
        });
    }

    private async checkPorts(results: DiagnosticResult[]): Promise<void> {
        if (!this.owner.config) {
            return;
        }

        const adminPort = this.owner.config.adminPort;
        const ports = [
            ['Admin proxy', adminPort],
            ['Admin internal', adminPort + HIDDEN_ADMIN_PORT_OFFSET],
            ['BrowserSync', adminPort + HIDDEN_BROWSER_SYNC_PORT_OFFSET],
            ['States DB', adminPort + STATES_DB_PORT_OFFSET],
            ['Objects DB', adminPort + OBJECTS_DB_PORT_OFFSET],
            ['Controller debugger', CONTROLLER_DEBUGGER_PORT],
            ['Adapter debugger', ADAPTER_DEBUGGER_PORT],
        ] as const;
        const owners = await getWindowsPortOwners();

        for (const [name, port] of ports) {
            const listening = await isPortListening(port);
            const pids = [...(owners.get(port) ?? [])];
            results.push({
                check: `${name} port`,
                status: listening ? 'warning' : 'ok',
                detail: listening
                    ? `${port} is in use${pids.length ? ` by PID ${pids.join(', ')}` : ''}`
                    : `${port} is available`,
            });
        }
    }

    private async checkLocks(results: DiagnosticResult[]): Promise<void> {
        const dataDir = path.join(this.owner.profilePath, 'iobroker-data');
        for (const name of ['objects.jsonl.lock', 'states.jsonl.lock']) {
            const lockPath = path.join(dataDir, name);
            if (!existsSync(lockPath)) {
                results.push({ check: `Database lock ${name}`, status: 'ok', detail: 'not present' });
                continue;
            }

            const lockStat = await stat(lockPath);
            const ageSeconds = Math.max(0, Math.round((Date.now() - lockStat.mtimeMs) / 1000));
            results.push({
                check: `Database lock ${name}`,
                status: 'warning',
                detail: `present, last changed ${ageSeconds}s ago`,
            });
        }
    }

    private async checkFrontend(results: DiagnosticResult[]): Promise<void> {
        let rootPackage: any;
        try {
            rootPackage = await readJson(path.join(this.owner.rootPath, 'package.json'));
        } catch {
            return;
        }

        const rootWatchScript = rootPackage.scripts?.['watch:react']
            ? 'watch:react'
            : rootPackage.scripts?.['watch:parcel']
              ? 'watch:parcel'
              : undefined;
        const watchers: string[] = rootWatchScript ? [`root: npm run ${rootWatchScript}`] : [];

        if (!rootWatchScript) {
            for (const directory of getNestedFrontendDirectories()) {
                const packagePath = path.join(this.owner.rootPath, directory, 'package.json');
                if (!existsSync(packagePath)) {
                    continue;
                }
                try {
                    const command = getNestedFrontendWatchCommand(directory, await readJson(packagePath));
                    if (command) {
                        watchers.push(`${directory}: npm ${command.args.join(' ')}`);
                    }
                } catch {
                    results.push({
                        check: `Frontend ${directory}`,
                        status: 'error',
                        detail: 'package.json cannot be parsed',
                    });
                }
            }
        }

        results.push({
            check: 'Frontend watchers',
            status: watchers.length ? 'ok' : 'warning',
            detail: watchers.length ? watchers.join('; ') : 'No supported frontend watcher detected',
        });

        results.push({
            check: 'TypeScript watcher',
            status: 'ok',
            detail: rootPackage.scripts?.['watch:ts'] ? 'npm run watch:ts' : 'not configured (optional)',
        });
    }

    private formatStatus(status: DiagnosticStatus): string {
        switch (status) {
            case 'ok':
                return 'OK';
            case 'warning':
                return 'WARN';
            case 'error':
                return 'ERROR';
        }
    }
}
