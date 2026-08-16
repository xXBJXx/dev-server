import { execFile } from 'node:child_process';
import { Socket } from 'node:net';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export function parseWindowsListeningPorts(output) {
    const result = new Map();
    for (const line of output.split(/\r?\n/)) {
        // A TCP listener has an unspecified remote endpoint ending in port 0.
        // Matching this instead of the state keeps parsing independent of the
        // localized netstat output (LISTENING, ABHÖREN, etc.).
        const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+:0\s+\S+\s+(\d+)\s*$/i);
        if (!match) {
            continue;
        }
        const port = parseInt(match[1]);
        const pid = parseInt(match[2]);
        const pids = result.get(port) ?? new Set();
        pids.add(pid);
        result.set(port, pids);
    }
    return result;
}
export async function getWindowsPortOwners() {
    if (process.platform !== 'win32') {
        return new Map();
    }
    try {
        const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true });
        return parseWindowsListeningPorts(stdout);
    }
    catch {
        return new Map();
    }
}
export function isPortListening(port) {
    return new Promise(resolve => {
        const socket = new Socket();
        const finish = (listening) => {
            socket.destroy();
            resolve(listening);
        };
        socket.setTimeout(300);
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.once('timeout', () => finish(false));
        socket.connect(port, '127.0.0.1');
    });
}
export async function findPortConflicts(ports) {
    const uniquePorts = [...new Map(ports.map(definition => [definition.port, definition])).values()];
    const [owners, listening] = await Promise.all([
        getWindowsPortOwners(),
        Promise.all(uniquePorts.map(async (definition) => ({ definition, listening: await isPortListening(definition.port) }))),
    ]);
    return listening
        .filter(result => result.listening)
        .map(({ definition }) => ({ ...definition, pids: [...(owners.get(definition.port) ?? [])] }));
}
export function formatPortConflict(conflict) {
    return `${conflict.name} ${conflict.port}${conflict.pids.length ? ` (PID ${conflict.pids.join(', ')})` : ''}`;
}
