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
import { getNestedFrontendWatchCommand } from '../dist/commands/frontendWatch.js';
import { parseWindowsListeningPorts } from '../dist/commands/Doctor.js';
import { isProcessRunning, terminateProcessTreeGracefully } from '../dist/commands/processTree.js';

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
