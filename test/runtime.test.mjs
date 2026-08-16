import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'mocha';
import {
    createAdminSocketMessage,
    parseAdminSocketMessage,
} from '../dist/commands/adminSocketProtocol.js';
import { HIDDEN_BROWSER_SYNC_PORT_OFFSET } from '../dist/commands/CommandBase.js';
import { Debug } from '../dist/commands/Debug.js';
import { getNestedFrontendWatchCommand } from '../dist/commands/frontendWatch.js';
import { parseWindowsListeningPorts } from '../dist/commands/Doctor.js';
import { findPortConflicts, formatPortConflict } from '../dist/commands/portDiagnostics.js';
import { isProcessRunning, terminateProcessTreeGracefully } from '../dist/commands/processTree.js';
import { Run } from '../dist/commands/Run.js';
import {
    ADAPTER_DEBUGGER_PORT,
    CONTROLLER_DEBUGGER_PORT,
    RunCommandBase,
} from '../dist/commands/RunCommandBase.js';
import { Watch } from '../dist/commands/Watch.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe('dev-server runtime regressions', () => {
    it('builds a valid object subscription message', () => {
        const id = 'system.adapter.example.0';
        assert.deepStrictEqual(JSON.parse(createAdminSocketMessage(1, 'subscribeObjects', [id])), [
            0,
            1,
            'subscribeObjects',
            [id],
        ]);
    });

    it('preserves all objectChange arguments from Admin', () => {
        const object = { common: { enabled: false }, native: { value: 1 } };
        assert.deepStrictEqual(parseAdminSocketMessage([0, 7, 'objectChange', ['system.adapter.example.0', object]]), {
            type: 'event',
            name: 'objectChange',
            args: ['system.adapter.example.0', object],
        });
    });

    it('recognizes Admin ping messages', () => {
        assert.deepStrictEqual(parseAdminSocketMessage([1]), { type: 'ping' });
    });

    it('keeps the executable shebang in the built CLI', async () => {
        const cli = await readFile(path.resolve(testDir, '..', 'dist', 'index.js'), 'utf8');
        assert.match(cli, /^#!\/usr\/bin\/env node\r?\n/);
    });

    it('starts a nested frontend watch script when one is provided', () => {
        assert.deepStrictEqual(getNestedFrontendWatchCommand('src-admin', { scripts: { watch: 'vite build --watch' } }), {
            directory: 'src-admin',
            args: ['--prefix', 'src-admin', 'run', 'watch'],
        });
    });

    it('adds Vite watch mode to nested frontend build scripts', () => {
        assert.deepStrictEqual(getNestedFrontendWatchCommand('src-admin', { scripts: { build: 'vite build' } }), {
            directory: 'src-admin',
            args: ['--prefix', 'src-admin', 'run', 'build', '--', '--watch'],
        });
    });

    it('does not turn arbitrary nested builds into persistent watchers', () => {
        assert.equal(getNestedFrontendWatchCommand('src-admin', { scripts: { build: 'webpack' } }), undefined);
    });

    it('extracts listening port owners from Windows netstat output', () => {
        const ports = parseWindowsListeningPorts(`
  TCP    127.0.0.1:8081         0.0.0.0:0              LISTENING       1234
  TCP    [::]:9229              [::]:0                 ABHÖREN         5678
  TCP    127.0.0.1:50000        127.0.0.1:443          ESTABLISHED     9999
`);
        assert.deepStrictEqual([...ports.get(8081)], [1234]);
        assert.deepStrictEqual([...ports.get(9229)], [5678]);
        assert.equal(ports.has(50000), false);
    });

    it('detects a listening startup port before launching child processes', async () => {
        const { createServer } = await import('node:net');
        const server = createServer();
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });

        try {
            const address = server.address();
            assert.notEqual(address, null);
            assert.equal(typeof address, 'object');
            const conflicts = await findPortConflicts([{ name: 'Test service', port: address.port }]);
            assert.equal(conflicts.length, 1);
            assert.equal(conflicts[0].name, 'Test service');
            assert.equal(conflicts[0].port, address.port);
            assert.match(formatPortConflict(conflicts[0]), new RegExp(`^Test service ${address.port}`));
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('preflights only the ports required by each run mode', () => {
        const owner = {
            adapterName: 'example',
            config: { adminPort: 8081, useSymlinks: false },
            log: {},
            profileName: 'default',
            profilePath: 'profile',
            rootPath: 'root',
        };

        const runPorts = new Run(owner, true).getStartupPorts();
        assert.ok(runPorts.some(definition => definition.port === CONTROLLER_DEBUGGER_PORT));
        assert.ok(runPorts.some(definition => definition.port === 8081 + HIDDEN_BROWSER_SYNC_PORT_OFFSET));

        const noStartPorts = new Watch(owner, false, true, [], false).getStartupPorts();
        assert.ok(noStartPorts.some(definition => definition.port === CONTROLLER_DEBUGGER_PORT));
        assert.ok(!noStartPorts.some(definition => definition.port === ADAPTER_DEBUGGER_PORT));
        assert.ok(!noStartPorts.some(definition => definition.port === 8081 + HIDDEN_BROWSER_SYNC_PORT_OFFSET));

        const watchPorts = new Watch(owner, true, true, [], true).getStartupPorts();
        assert.ok(watchPorts.some(definition => definition.port === ADAPTER_DEBUGGER_PORT));
        assert.ok(watchPorts.some(definition => definition.port === 8081 + HIDDEN_BROWSER_SYNC_PORT_OFFSET));

        const debugPorts = new Debug(owner, false, true).getStartupPorts();
        assert.ok(debugPorts.some(definition => definition.port === CONTROLLER_DEBUGGER_PORT));
        assert.ok(debugPorts.some(definition => definition.port === ADAPTER_DEBUGGER_PORT));
    });

    it('aborts before starting work when the preflight finds a conflict', async () => {
        const { createServer } = await import('node:net');
        const server = createServer();
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });

        let workStarted = false;
        class PreflightTestCommand extends RunCommandBase {
            getStartupPorts() {
                return [{ name: 'Occupied test service', port: server.address().port }];
            }

            async doRun() {
                workStarted = true;
            }
        }

        const owner = {
            adapterName: 'example',
            config: { adminPort: 8081, useSymlinks: false },
            log: {},
            profileName: 'test-profile',
            profilePath: 'profile',
            rootPath: 'root',
        };

        try {
            await assert.rejects(
                new PreflightTestCommand(owner).run(),
                /Cannot start dev-server profile "test-profile".*Occupied test service/i,
            );
            assert.equal(workStarted, false);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('terminates a spawned process tree', async function () {
        this.timeout(10_000);
        const parent = spawn(
            process.execPath,
            [
                '-e',
                `const { spawn } = require('node:child_process');
                 const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
                 console.log(child.pid);
                 setInterval(() => {}, 1000);`,
            ],
            { stdio: ['ignore', 'pipe', 'ignore'] },
        );

        const childPid = await new Promise((resolve, reject) => {
            parent.once('error', reject);
            parent.stdout.once('data', data => resolve(parseInt(data.toString('utf8').trim())));
        });

        try {
            assert.equal(isProcessRunning(parent.pid), true);
            assert.equal(isProcessRunning(childPid), true);
            await terminateProcessTreeGracefully(parent.pid);
            assert.equal(isProcessRunning(parent.pid), false);
            assert.equal(isProcessRunning(childPid), false);
        } finally {
            if (isProcessRunning(parent.pid)) {
                await terminateProcessTreeGracefully(parent.pid, 100);
            }
            if (isProcessRunning(childPid)) {
                await terminateProcessTreeGracefully(childPid, 100);
            }
        }
    });
});
