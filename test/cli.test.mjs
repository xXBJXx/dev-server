import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

    it('offers the doctor command', () => {
        const result = runCli('--help');
        const output = `${result.stdout}${result.stderr}`;

        assert.equal(result.status, 0);
        assert.match(output, /doctor \[profile\]/i);
    });

    it('rejects an Admin port whose derived internal ports would overflow', () => {
        const adapterDir = mkdtempSync(path.join(tmpdir(), 'dev-server-port-validation-'));
        try {
            writeFileSync(path.join(adapterDir, 'package.json'), JSON.stringify({ name: 'iobroker.port-test' }));
            writeFileSync(
                path.join(adapterDir, 'io-package.json'),
                JSON.stringify({ common: { name: 'port-test' } }),
            );

            const result = runCli('setup', '--adminPort', '50000', '--root', adapterDir);
            const output = `${result.stdout}${result.stderr}`;
            assert.notStrictEqual(result.status, 0);
            assert.match(output, /Admin port must not exceed 47190/i);
            assert.equal(result.signal, null);
        } finally {
            rmSync(adapterDir, { recursive: true, force: true });
        }
    });

    it('prints a remote setup dry-run without creating profile data or prompting', () => {
        const adapterDir = mkdtempSync(path.join(tmpdir(), 'dev-server-setup-plan-'));
        try {
            writeFileSync(
                path.join(adapterDir, 'package.json'),
                JSON.stringify({ name: 'iobroker.plan-test', scripts: { build: 'echo build' } }),
            );
            writeFileSync(
                path.join(adapterDir, 'io-package.json'),
                JSON.stringify({ common: { name: 'plan-test' } }),
            );

            const result = runCli('setup', '--dryRun', '--remote', '--root', adapterDir);
            const output = `${result.stdout}${result.stderr}`;
            assert.equal(result.status, 0);
            assert.match(output, /Dry-run setup plan/i);
            assert.match(output, /Configure remote/i);
            assert.equal(existsSync(path.join(adapterDir, '.dev-server')), false);
        } finally {
            rmSync(adapterDir, { recursive: true, force: true });
        }
    });

    it('prints machine-readable doctor JSON without a log preamble', () => {
        const adapterDir = mkdtempSync(path.join(tmpdir(), 'dev-server-doctor-'));
        try {
            writeFileSync(path.join(adapterDir, 'package.json'), JSON.stringify({ name: 'iobroker.doctor-test' }));
            writeFileSync(
                path.join(adapterDir, 'io-package.json'),
                JSON.stringify({ common: { name: 'doctor-test' } }),
            );

            const result = runCli('doctor', '--json', '--root', adapterDir);
            assert.equal(result.status, 0);
            const output = JSON.parse(result.stdout);
            assert.equal(output.profile, 'default');
            assert.ok(output.results.some(entry => entry.check === 'Profile setup' && entry.status === 'error'));
        } finally {
            rmSync(adapterDir, { recursive: true, force: true });
        }
    });
});
