import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'mocha';
import {
    createAdminSocketMessage,
    parseAdminSocketMessage,
} from '../dist/commands/adminSocketProtocol.js';
import {
    CommandBase,
    getAdminPortValidationError,
    HIDDEN_BROWSER_SYNC_PORT_OFFSET,
    OBJECTS_DB_PORT_OFFSET,
} from '../dist/commands/CommandBase.js';
import { Debug } from '../dist/commands/Debug.js';
import { getNestedFrontendWatchCommand } from '../dist/commands/frontendWatch.js';
import { FileChangeBatcher } from '../dist/commands/FileChangeBatcher.js';
import { injectLiveReloadClient, LiveReloadServer } from '../dist/commands/LiveReloadServer.js';
import { injectCode } from '../dist/jsonConfig.js';
import { Doctor, parseWindowsListeningPorts } from '../dist/commands/Doctor.js';
import { findPortConflicts, formatPortConflict } from '../dist/commands/portDiagnostics.js';
import { isProcessRunning, terminateProcessTreeGracefully } from '../dist/commands/processTree.js';
import { Run } from '../dist/commands/Run.js';
import {
    ADAPTER_DEBUGGER_PORT,
    CONTROLLER_DEBUGGER_PORT,
    RunCommandBase,
} from '../dist/commands/RunCommandBase.js';
import { Watch } from '../dist/commands/Watch.js';
import { findDescendantProcesses, parseWindowsProcessList } from '../dist/commands/utils.js';
import { RemoteConnection } from '../dist/commands/RemoteConnection.js';
import { Update } from '../dist/commands/Update.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe('dev-server runtime regressions', () => {
    it('validates the Admin port together with derived internal ports', () => {
        assert.equal(getAdminPortValidationError(8081), undefined);
        assert.match(getAdminPortValidationError(1.5), /integer/i);
        assert.match(getAdminPortValidationError(0), /greater than 0/i);
        assert.match(getAdminPortValidationError(9228), /reserved/i);
        assert.match(getAdminPortValidationError(9229), /reserved/i);
        assert.equal(getAdminPortValidationError(65535 - OBJECTS_DB_PORT_OFFSET), undefined);
        assert.match(getAdminPortValidationError(65536 - OBJECTS_DB_PORT_OFFSET), /must not exceed/i);
    });

    it('reports an invalid profile port through doctor without probing invalid sockets', async () => {
        const owner = {
            adapterName: 'example',
            config: { adminPort: 50000, useSymlinks: false },
            isSetUp: () => true,
            profileName: 'invalid-port',
            profilePath: path.join(tmpdir(), 'missing-dev-server-profile'),
            readMyPackageJson: async () => ({ engines: { node: '>=20' } }),
            rootPath: path.join(tmpdir(), 'missing-dev-server-adapter'),
        };

        const results = await new Doctor(owner).diagnose();
        const portResult = results.find(result => result.check === 'Admin port configuration');
        assert.equal(portResult.status, 'error');
        assert.match(portResult.detail, /must not exceed 47190/i);
        assert.ok(!results.some(result => result.check === 'Objects DB port'));
    });

    it('builds a valid object subscription message', () => {
        const id = 'system.adapter.example.0';
        assert.deepStrictEqual(JSON.parse(createAdminSocketMessage(1, 'subscribeObjects', [id])), [
            0,
            1,
            'subscribeObjects',
            [id],
        ]);
    });

    it('always tears commands down and logs their elapsed phase', async () => {
        const messages = [];
        let tornDown = false;
        class FailingCommand extends CommandBase {
            async doRun() {
                throw new Error('expected failure');
            }

            async teardown() {
                tornDown = true;
            }
        }
        const owner = {
            adapterName: 'example',
            config: { adminPort: 8081, useSymlinks: false },
            log: { debug: message => messages.push(message) },
            profilePath: 'profile',
            rootPath: 'root',
        };

        await assert.rejects(new FailingCommand(owner).run(), /expected failure/);
        assert.equal(tornDown, true);
        assert.ok(messages.some(message => /^\[FailingCommand\] Starting/.test(message)));
        assert.ok(
            messages.some(message => /^\[FailingCommand\] Initialization phase completed after \d+ ms/.test(message)),
        );
    });

    it('packs the adapter only once during update', async () => {
        const installCalls = [];
        const uploaded = [];
        let buildCalls = 0;
        class UpdateTest extends Update {
            async buildLocalAdapter() {
                buildCalls++;
            }

            async installLocalAdapter(doInstall) {
                installCalls.push(doInstall);
            }

            async uploadAdapter(name) {
                uploaded.push(name);
            }
        }
        const owner = {
            adapterName: 'example',
            config: { adminPort: 8081, useSymlinks: false },
            log: { box: () => undefined, debug: () => undefined, notice: () => undefined },
            profilePath: 'profile',
            rootPath: 'root',
        };
        const update = new UpdateTest(owner);
        update.profileDir = { exec: async () => undefined };

        await update.run();
        assert.equal(buildCalls, 1);
        assert.deepStrictEqual(installCalls, [undefined]);
        assert.deepStrictEqual(uploaded, ['admin', 'example']);
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

    it('collapses file-system bursts and serializes synchronization batches', async () => {
        const batches = [];
        const batcher = new FileChangeBatcher(async changes => {
            batches.push(changes.map(change => ({ ...change })));
        }, 10);

        batcher.enqueue('build/main.js', 'upsert');
        batcher.enqueue('build/main.js', 'upsert');
        batcher.enqueue('build/main.js.map', 'upsert');
        batcher.enqueue('build/main.js', 'unlink');
        await batcher.flush();
        await batcher.close();

        assert.deepStrictEqual(batches, [
            [
                { filename: 'build/main.js', type: 'unlink' },
                { filename: 'build/main.js.map', type: 'upsert' },
            ],
        ]);
    });

    it('injects the built-in live-reload client exactly once', () => {
        const once = injectLiveReloadClient('<html><body>Admin</body></html>');
        const twice = injectLiveReloadClient(once);
        assert.match(once, /data-dev-server-live-reload/);
        assert.match(once, /new EventSource\('\/__dev_server_reload\/events'\)/);
        assert.equal(twice, once);
    });

    it('uses built-in live-reload events for jsonConfig updates', () => {
        const html = injectCode('<html><head></head><body></body></html>', 'example', 'jsonConfig.json');
        assert.match(html, /new EventSource\("\/__dev_server_reload\/events"\)/);
        assert.doesNotMatch(html, /socket\.io|browser-sync/);
    });

    it('serves HTML and broadcasts a reload after a file change', async function () {
        this.timeout(10_000);
        const directory = await mkdtemp(path.join(tmpdir(), 'dev-server-live-reload-'));
        const htmlPath = path.join(directory, 'index.html');
        await writeFile(htmlPath, '<html><body>before</body></html>');
        const server = new LiveReloadServer(directory, 0, 0, { warn: () => undefined });

        try {
            await server.start();
            const response = await fetch(`http://127.0.0.1:${server.listeningPort}/index.html`);
            assert.equal(response.status, 200);
            assert.match(await response.text(), /data-dev-server-live-reload/);

            const { get } = await import('node:http');
            await new Promise((resolve, reject) => {
                let changed = false;
                let received = '';
                const timeout = setTimeout(() => reject(new Error('Timed out waiting for reload event')), 5_000);
                const request = get(`http://127.0.0.1:${server.listeningPort}/__dev_server_reload/events`, res => {
                    res.setEncoding('utf8');
                    res.on('data', chunk => {
                        received += chunk;
                        if (!changed && received.includes('connected')) {
                            changed = true;
                            void writeFile(htmlPath, '<html><body>after</body></html>').catch(reject);
                        }
                        if (received.includes('event: reload')) {
                            clearTimeout(timeout);
                            request.destroy();
                            resolve();
                        }
                    });
                });
                request.once('error', error => {
                    if (error.code !== 'ECONNRESET') {
                        clearTimeout(timeout);
                        reject(error);
                    }
                });
            });
        } finally {
            await server.close();
            await rm(directory, { recursive: true, force: true });
        }
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

    it('parses modern Windows process data and finds complete descendant trees', () => {
        const processes = parseWindowsProcessList(
            JSON.stringify([
                { ProcessId: 100, ParentProcessId: 1, Name: 'npm.exe' },
                { ProcessId: 300, ParentProcessId: 200, Name: 'node.exe' },
                { ProcessId: 200, ParentProcessId: 100, Name: 'cmd.exe' },
                { ProcessId: 400, ParentProcessId: 1, Name: 'unrelated.exe' },
            ]),
        );
        assert.deepStrictEqual(
            findDescendantProcesses(processes, 100).map(processInfo => Number(processInfo.PID)),
            [200, 300],
        );
    });

    it('shares concurrent SSH connects and reconnects after an unexpected close', async () => {
        class FakeSshClient extends EventEmitter {
            connectCalls = 0;
            endCalls = 0;

            connect() {
                this.connectCalls++;
                queueMicrotask(() => this.emit('ready'));
            }

            end() {
                this.endCalls++;
                this.emit('close');
            }
        }

        const clients = [];
        const warnings = [];
        const signalListenersBefore = process.listenerCount('SIGINT');
        const remote = new RemoteConnection(
            { id: 'test', host: 'example.invalid', port: 22, user: 'tester' },
            {
                debug: () => undefined,
                error: () => undefined,
                notice: () => undefined,
                silly: () => undefined,
                warn: message => warnings.push(message),
            },
            () => {
                const client = new FakeSshClient();
                clients.push(client);
                return client;
            },
        );
        try {
            await Promise.all([remote.connect(), remote.connect()]);
            assert.equal(clients.length, 1);
            assert.equal(clients[0].connectCalls, 1);
            assert.equal(process.listenerCount('SIGINT'), signalListenersBefore + 1);

            clients[0].emit('close');
            assert.match(warnings.at(-1), /reconnect automatically/i);
            await remote.connect();
            assert.equal(clients.length, 2);
            assert.equal(process.listenerCount('SIGINT'), signalListenersBefore + 1);
        } finally {
            remote.close();
        }
        assert.equal(process.listenerCount('SIGINT'), signalListenersBefore);
        assert.equal(clients[1].endCalls, 1);
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
            log: { debug: () => undefined },
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

    it('adds workspace library paths to the local nodemon watcher', () => {
        class WatchConfigTest extends Watch {
            getConfig(script, baseDir) {
                return this.createNodemonConfig(script, baseDir);
            }
        }
        const rootPath = path.resolve('adapter-root');
        const owner = {
            adapterName: 'example',
            config: { adminPort: 8081, useSymlinks: false },
            log: {},
            profileName: 'default',
            profilePath: path.resolve('profile'),
            rootPath,
        };
        const watch = new WatchConfigTest(owner, true, true, [], true, ['../shared-library']);
        const config = watch.getConfig('main.js', path.resolve('installed-adapter'));

        assert.ok(config.watch.includes(path.resolve(rootPath, '../shared-library')));
    });

    it('synchronizes initial, changed and deleted www files to ioBroker storage', async function () {
        this.timeout(10_000);
        class WwwWatchTest extends Watch {
            events = [];

            sendSocketEvent(name, args, callback) {
                this.events.push({ name, args, callback });
            }

            startWww() {
                return this.startWwwSync();
            }

            stopWww() {
                return this.stopRuntime();
            }
        }

        const rootPath = await mkdtemp(path.join(tmpdir(), 'dev-server-www-'));
        const wwwPath = path.join(rootPath, 'www');
        const filePath = path.join(wwwPath, 'index.html');
        await mkdir(wwwPath);
        await writeFile(filePath, 'initial');
        const owner = {
            adapterName: 'example',
            config: { adminPort: 8081, useSymlinks: false },
            log: { debug: () => undefined, notice: () => undefined, warn: () => undefined },
            profileName: 'default',
            profilePath: path.resolve(rootPath, 'profile'),
            rootPath,
        };
        const watch = new WwwWatchTest(owner, false, true, [], false);
        const waitForEventCount = async expected => {
            for (let attempt = 0; attempt < 40 && watch.events.length < expected; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            assert.ok(watch.events.length >= expected, `Expected ${expected} www events, got ${watch.events.length}`);
        };

        try {
            await watch.startWww();
            await waitForEventCount(1);
            assert.deepStrictEqual(watch.events[0], {
                name: 'writeFile',
                args: ['example', 'index.html', Buffer.from('initial').toString('base64')],
                callback: true,
            });

            await writeFile(filePath, 'changed');
            await waitForEventCount(2);
            assert.deepStrictEqual(watch.events[1].args, [
                'example',
                'index.html',
                Buffer.from('changed').toString('base64'),
            ]);

            await rm(filePath);
            await waitForEventCount(3);
            assert.deepStrictEqual(watch.events[2], {
                name: 'unlink',
                args: ['example', 'index.html'],
                callback: true,
            });
        } finally {
            await watch.stopWww();
            await rm(rootPath, { recursive: true, force: true });
        }
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
            log: { debug: () => undefined },
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
        this.timeout(20_000);
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
