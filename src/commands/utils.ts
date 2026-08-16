import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProcessInfo {
    PID: string;
    PPID: string;
    COMMAND: string;
    STAT?: string;
}

export function escapeStringRegexp(value: string): string {
    // Escape characters with special meaning either inside or outside character sets.
    // Use a simple backslash escape when it’s always valid, and a `\xnn` escape when the simpler form would be disallowed by Unicode patterns’ stricter grammar.
    return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&').replace(/-/g, '\\x2d');
}

export async function readJson<T = any>(filePath: string): Promise<T> {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
}

export async function writeJson(filePath: string, data: any): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    await writeFile(filePath, content, 'utf-8');
}

export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function checkPort(port: number, host = '127.0.0.1', timeout = 1000): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = new Socket();

        const onError = (error: string): void => {
            socket.destroy();
            reject(new Error(error));
        };

        socket.setTimeout(timeout);
        socket.once('error', onError);
        socket.once('timeout', onError);
        socket.once('close', onError);

        socket.connect(port, host, () => {
            setTimeout(() => {
                resolve();
                socket.end();
            }, 100); // slight delay to ensure port is ready
        });
    });
}

export function findDescendantProcesses(processes: readonly ProcessInfo[], parentPid: number): readonly ProcessInfo[] {
    const parentPids = new Set([parentPid.toString()]);
    const descendants: ProcessInfo[] = [];
    let foundAnotherLevel = true;

    while (foundAnotherLevel) {
        foundAnotherLevel = false;
        for (const processInfo of processes) {
            if (parentPids.has(processInfo.PPID) && !parentPids.has(processInfo.PID)) {
                parentPids.add(processInfo.PID);
                descendants.push(processInfo);
                foundAnotherLevel = true;
            }
        }
    }

    return descendants;
}

export function parseWindowsProcessList(output: string): readonly ProcessInfo[] {
    if (!output.trim()) {
        return [];
    }

    const parsed = JSON.parse(output) as
        | { ProcessId: number; ParentProcessId: number; Name: string }
        | Array<{ ProcessId: number; ParentProcessId: number; Name: string }>;
    return (Array.isArray(parsed) ? parsed : [parsed]).map(processInfo => ({
        PID: String(processInfo.ProcessId),
        PPID: String(processInfo.ParentProcessId),
        COMMAND: processInfo.Name,
    }));
}

function parsePosixProcessList(output: string): readonly ProcessInfo[] {
    const processes: ProcessInfo[] = [];
    for (const line of output.split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (match) {
            processes.push({ PPID: match[1], PID: match[2], STAT: match[3], COMMAND: match[4] });
        }
    }
    return processes;
}

export async function getChildProcesses(parentPid: number): Promise<readonly ProcessInfo[]> {
    let processes: readonly ProcessInfo[];
    if (process.platform === 'win32') {
        const options = { windowsHide: true, maxBuffer: 10 * 1024 * 1024 };
        let stdout: string;
        try {
            const command =
                'Get-Process | ForEach-Object { $parentId = 0; try { if ($_.Parent) { $parentId = $_.Parent.Id } } catch {}; [PSCustomObject]@{ ProcessId = $_.Id; ParentProcessId = $parentId; Name = $_.ProcessName } } | ConvertTo-Json -Compress';
            ({ stdout } = await execFileAsync(
                'pwsh.exe',
                ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
                options,
            ));
        } catch {
            // Windows PowerShell 5 has no Process.Parent property. CIM is the
            // supported fallback on systems that do not have PowerShell 7.
            const command =
                'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';
            ({ stdout } = await execFileAsync(
                'powershell.exe',
                ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
                options,
            ));
        }
        processes = parseWindowsProcessList(stdout);
    } else {
        const { stdout } = await execFileAsync('ps', ['-A', '-o', 'ppid=,pid=,stat=,comm=']);
        processes = parsePosixProcessList(stdout);
    }

    return findDescendantProcesses(processes, parentPid);
}
