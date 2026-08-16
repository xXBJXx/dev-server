import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'mocha';
import {
    createAdminSocketMessage,
    parseAdminSocketMessage,
} from '../dist/commands/adminSocketProtocol.js';
import { getNestedFrontendWatchCommand } from '../dist/commands/frontendWatch.js';

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
});
