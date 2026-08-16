import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delay, getChildProcesses } from './utils.js';

const execFileAsync = promisify(execFile);

export function isProcessRunning(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Terminate a process and all descendants without invoking a shell. */
export async function terminateProcessTree(pid: number, force = false): Promise<void> {
    if (!isProcessRunning(pid)) {
        return;
    }

    if (process.platform === 'win32') {
        const args = ['/PID', pid.toString(), '/T'];
        if (force) {
            args.push('/F');
        }

        try {
            await execFileAsync('taskkill.exe', args, { windowsHide: true });
            return;
        } catch {
            // taskkill returns a non-zero code when the process exited between
            // the liveness check and the command.
            if (!isProcessRunning(pid)) {
                return;
            }
        }
        // Sandboxed Windows environments may deny taskkill even for child
        // processes. Fall through to direct signals as a best-effort fallback.
    }

    let descendants: readonly { PID: string }[] = [];
    try {
        descendants = await getChildProcesses(pid);
    } catch {
        // The root process can still be terminated if process enumeration is
        // unavailable on a non-Windows platform.
    }

    const signal = force ? 'SIGKILL' : process.platform === 'win32' ? 'SIGTERM' : 'SIGINT';
    for (const child of [...descendants].reverse()) {
        try {
            process.kill(parseInt(child.PID), signal);
        } catch {
            // Process already exited.
        }
    }

    try {
        process.kill(pid, signal);
    } catch {
        // Process already exited.
    }
}

export async function terminateProcessTreeGracefully(pid: number, timeoutMs = 2000): Promise<void> {
    // Windows has no signal equivalent that reliably propagates through an npm
    // or command wrapper. taskkill /T /F is the native, deterministic tree
    // operation and avoids leaving detached adapter processes behind.
    if (process.platform === 'win32') {
        let descendantPids: number[] = [];
        try {
            descendantPids = (await getChildProcesses(pid)).map(processInfo => parseInt(processInfo.PID));
        } catch {
            // taskkill /T remains the primary tree operation if process
            // enumeration is unavailable.
        }
        await terminateProcessTree(pid, true);
        for (const childPid of descendantPids.reverse()) {
            if (isProcessRunning(childPid)) {
                await terminateProcessTree(childPid, true);
            }
        }

        const deadline = Date.now() + timeoutMs;
        while ([pid, ...descendantPids].some(isProcessRunning) && Date.now() < deadline) {
            await delay(25);
        }
        return;
    }

    await terminateProcessTree(pid, false);

    const deadline = Date.now() + timeoutMs;
    while (isProcessRunning(pid) && Date.now() < deadline) {
        await delay(50);
    }

    if (isProcessRunning(pid)) {
        await terminateProcessTree(pid, true);
    }
}
