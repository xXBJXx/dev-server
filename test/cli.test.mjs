import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'mocha';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const devServerPath = path.resolve(testDir, '..', 'dist', 'index.js');

function runCli(...args) {
    return spawnSync(process.execPath, [devServerPath, ...args], {
        cwd: path.resolve(testDir, '..'),
        encoding: 'utf8',
        timeout: 10_000,
    });
}

describe('dev-server CLI validation', function () {
    this.timeout(15_000);

    it('rejects unknown command options', () => {
        const result = runCli('watch', '--nodtart');
        const output = `${result.stdout}${result.stderr}`;

        assert.notStrictEqual(result.status, 0);
        assert.match(output, /Unknown argument: nodtart/i);
        assert.doesNotMatch(output, /Install local iobroker/i);
    });

    it('rejects unknown commands and recommends close matches', () => {
        const result = runCli('watc');
        const output = `${result.stdout}${result.stderr}`;

        assert.notStrictEqual(result.status, 0);
        assert.match(output, /Did you mean watch/i);
        assert.doesNotMatch(output, /Install local iobroker/i);
    });

    it('requires an explicit command', () => {
        const result = runCli();
        const output = `${result.stdout}${result.stderr}`;

        assert.notStrictEqual(result.status, 0);
        assert.match(output, /You must specify a command/i);
    });
});
