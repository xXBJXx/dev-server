import enquirer from 'enquirer';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { type ConnectConfig, type SFTPWrapper, Client as SSHClient } from 'ssh2';
import { exec as ssh2ExecAsync } from 'ssh2-exec/promises';
import type { RemoteConfig } from '../DevServer.js';
import { type Logger } from '../logger.js';
import type { IEnvironment } from './IEnvironment.js';
import { delay } from './utils.js';

type ConnectState = 'disconnected' | 'connecting' | 'connected';

export class RemoteConnection implements IEnvironment {
    private client?: SSHClient;
    private connectState: ConnectState = 'disconnected';
    private connectPromise?: Promise<void>;
    private intentionalClose = false;
    private readonly childProcesses: number[] = [];
    private readonly tunnelServers: Server[] = [];
    private readonly tunnelSockets = new Set<Socket>();
    private connectSftp?: Promise<SftpConnection>;
    private homeDir?: string;
    private signalHandler?: () => void;

    constructor(
        private readonly config: RemoteConfig,
        private readonly log: Logger,
        private readonly clientFactory: () => SSHClient = () => new SSHClient(),
    ) {}

    public async connect(): Promise<void> {
        if (this.connectState === 'connected') {
            return;
        }
        if (this.connectPromise) {
            return this.connectPromise;
        }

        this.log.notice(`Connecting to ${this.config.user}@${this.config.host}...`);
        this.intentionalClose = false;
        this.connectState = 'connecting';
        const client = this.clientFactory();
        this.client = client;
        const attempt = new Promise<void>((resolve, reject) => {
            const fail = (error: Error): void => {
                if (this.client === client) {
                    this.connectState = 'disconnected';
                    this.connectSftp = undefined;
                    this.client = undefined;
                }
                reject(error);
            };
            client.once('ready', () => {
                if (this.client !== client) {
                    return;
                }
                this.connectState = 'connected';
                resolve();
            });
            client.once('error', err => {
                this.log.error(`SSH connection error: ${err.message}`);
                fail(err);
            });
            client.once('close', () => {
                this.handleDisconnect(client);
                if (this.connectState !== 'connected') {
                    fail(new Error('SSH connection closed before it became ready'));
                }
            });
            const connectConfig: ConnectConfig = {
                host: this.config.host,
                port: this.config.port,
                username: this.config.user,
            };
            if (this.config.privateKeyPath) {
                connectConfig.privateKey = readFileSync(this.config.privateKeyPath);
            } else {
                connectConfig.tryKeyboard = true;
                client.on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
                    this.log.notice(instructions);
                    async function askPassword(): Promise<string[]> {
                        const result: string[] = [];
                        for (const p of prompts) {
                            const answer = await enquirer.prompt<{ password: string }>({
                                name: 'password',
                                type: p.echo ? 'text' : 'password',
                                message: p.prompt,
                            });
                            result.push(answer.password);
                        }
                        return result;
                    }
                    askPassword()
                        .then(finish)
                        .catch(err => this.log.error(`Error getting password: ${err}`));
                });
            }

            client.connect(connectConfig);
        });
        this.connectPromise = attempt;
        try {
            await attempt;
        } finally {
            if (this.connectPromise === attempt) {
                this.connectPromise = undefined;
            }
        }
        if (this.client !== client || !this.isConnected()) {
            throw new Error('SSH connection closed immediately after authentication');
        }

        this.log.debug('Remote SSH connection established');

        if (!this.signalHandler) {
            this.signalHandler = (): void =>
                void this.exitChildProcesses('SIGINT').catch(e =>
                    this.log.silly(`Couldn't exit child processes: ${e.message}`),
                );
            process.on('SIGINT', this.signalHandler);
        }
    }

    public close(): void {
        this.intentionalClose = true;
        this.log.debug('Closing tunnels...');
        for (const server of this.tunnelServers) {
            server.close();
        }
        this.tunnelServers.length = 0;
        for (const socket of this.tunnelSockets) {
            socket.destroy();
        }
        this.tunnelSockets.clear();

        this.log.debug('Closing remote SSH connection');
        this.connectState = 'disconnected';
        this.connectPromise = undefined;
        this.connectSftp = undefined;
        this.homeDir = undefined;
        const client = this.client;
        this.client = undefined;
        client?.end();
        if (this.signalHandler) {
            process.off('SIGINT', this.signalHandler);
            this.signalHandler = undefined;
        }
    }

    public async readFile(relPath: string): Promise<string> {
        const remotePath = await this.getFullRemotePath(relPath);
        const sftp = await this.getSftp();
        const buffer = await sftp.readFile(remotePath);
        return buffer.toString();
    }

    public async writeFile(relPath: string, data: string): Promise<void> {
        const remotePath = await this.getFullRemotePath(relPath);
        const sftp = await this.getSftp();
        await sftp.writeFile(remotePath, data);
    }

    public async readJson<T = any>(relPath: string): Promise<T> {
        const content = await this.readFile(relPath);
        return JSON.parse(content) as T;
    }

    public async writeJson(relPath: string, data: any): Promise<void> {
        const content = JSON.stringify(data, null, 2);
        return this.writeFile(relPath, content);
    }

    public async copyFileTo(src: string, dest: string): Promise<void> {
        await this.upload(src, dest);
    }

    public async exists(relPath: string): Promise<boolean> {
        const remotePath = await this.getFullRemotePath(relPath);
        const sftp = await this.getSftp();
        return sftp.exists(remotePath);
    }

    public async unlink(relPath: string): Promise<void> {
        const remotePath = await this.getFullRemotePath(relPath);
        const sftp = await this.getSftp();
        await sftp.unlink(remotePath);
    }

    public async spawn(
        command: string,
        args: ReadonlyArray<string>,
        onExit: (exitCode: number) => void | Promise<void>,
    ): Promise<number | null> {
        const client = await this.getClient();
        const basePath = this.getBasePath();
        const fullCommand = `${command} ${args.map(a => `"${a}"`).join(' ')}`;
        this.log.debug(`${this.config.user}@${this.config.host}:${basePath}> ${fullCommand}`);

        command = this.asBashCommand(`cd ${basePath} ; echo "PID=>$$<" ; exec ${fullCommand}`);

        return new Promise((resolve, reject) => {
            client.exec(command, { pty: true }, (err, stream) => {
                if (err) {
                    return reject(err);
                }
                resolve(null);

                stream.once('data', (data: Buffer) => {
                    const match = data.toString().match(/PID=>(\d+)</);
                    if (match) {
                        const pid = parseInt(match[1], 10);
                        this.log.silly(`Spawned remote process with PID ${pid}`);
                        this.childProcesses.push(pid);
                    }
                });

                stream.on('close', (code: number | undefined) => {
                    onExit(code ?? 1)?.catch((e: any) => this.log.error(`Error in onExit handler: ${e.message}`));
                });

                stream.pipe(process.stdout, { end: false });
                stream.stderr.pipe(process.stderr, { end: false });
            });
        });
    }

    public async exec(command: string): Promise<void> {
        const client = await this.getClient();
        const basePath = this.getBasePath();
        this.log.debug(`${this.config.user}@${this.config.host}:${basePath}> ${command}`);

        command = this.asBashCommand(`cd ${basePath} ; ${command}`);

        return new Promise((resolve, reject) => {
            client.exec(command, { pty: true }, (err, stream) => {
                if (err) {
                    return reject(err);
                }
                stream.on('close', (code: number, signal: string) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`Command failed with code ${code} (${signal})`));
                    }
                });

                stream.pipe(process.stdout, { end: false });
                stream.stderr.pipe(process.stderr, { end: false });
            });
        });
    }

    public async execWithExistingFile(fullPath: string, commandBuilder: (remotePath: string) => string): Promise<void> {
        const filename = path.basename(fullPath);
        const remotePath = await this.upload(fullPath, filename);
        await this.exec(commandBuilder(remotePath));
    }

    public async execWithNewFile(localPath: string, commandBuilder: (remotePath: string) => string): Promise<void> {
        const filename = path.basename(localPath);
        const remotePath = await this.getFullRemotePath(filename);
        await this.exec(commandBuilder(remotePath));

        const sftp = await this.getSftp();
        await sftp.get(remotePath, localPath);

        await this.exec(`rm -f "${remotePath}"`);
    }

    public async getExecOutput(command: string): Promise<string> {
        const client = await this.getClient();
        this.log.debug(`${this.config.user}@${this.config.host}> ${command}`);
        command = this.asBashCommand(command);
        const result = await ssh2ExecAsync({
            ssh: client,
            command,
            end: false,
        });
        return result.stdout;
    }

    private asBashCommand(command: string): string {
        command = `/usr/bin/bash -lic '${command.replace(/'/g, "'\\''")}'`;
        this.log.silly(`Remote command: ${command}`);
        return command;
    }

    public async exitChildProcesses(signal: string): Promise<void> {
        if (signal === 'SIGKILL') {
            this.close();
        } else if (this.childProcesses.length > 0) {
            const pids = [...this.childProcesses];
            this.childProcesses.length = 0;
            for (const pid of pids) {
                try {
                    await this.getExecOutput(`kill -s ${signal} ${pid}`);
                } catch (err: any) {
                    this.log.silly(`Failed to send ${signal} to remote process ${pid}: ${err}`);
                }
            }

            // first try SIGINT and give it 5s to exit itself before killing the processes left
            await delay(5000);
            await this.exitChildProcesses('SIGKILL');
        }
    }

    public sendSigIntToChildProcesses(): void {
        // this method is only used locally when there is no TTY
        this.close();
    }

    public async tunnelPort(port: number): Promise<void> {
        this.log.notice(`Preparing tunnel for port ${port}...`);
        const server = createServer(sock => {
            this.tunnelSockets.add(sock);
            sock.once('close', () => this.tunnelSockets.delete(sock));
            sock.pause();

            this.log.silly(`Client connected to port ${port}, opening tunnel...`);
            void this.getClient()
                .then(client =>
                    client.forwardOut('127.0.0.1', port, '127.0.0.1', port, (err, stream) => {
                        if (err) {
                            this.log.silly(`forwardOut for port ${port} failed: ${err.message}`);
                            sock.destroy();
                            return;
                        }

                        this.log.silly(
                            `Tunnel for port ${port} established (${sock.remoteAddress}:${sock.remotePort}).`,
                        );
                        sock.pipe(stream);
                        stream.pipe(sock);
                        sock.resume();
                    }),
                )
                .catch(error => {
                    this.log.silly(`Could not reconnect tunnel for port ${port}: ${error as Error}`);
                    sock.destroy();
                });
        });

        this.tunnelServers.push(server);
        return new Promise<void>((resolve, reject) => {
            server.on('error', err => {
                this.log.error(`Failed to create local tunnel server: ${err.message}`);
                reject(err);
            });
            server.on('listening', () => {
                resolve();
            });
            server.listen(port, '127.0.0.1');
        });
    }

    public async upload(localPath: string, relPath: string): Promise<string> {
        const remotePath = await this.getFullRemotePath(relPath);

        const sftp = await this.getSftp();
        await sftp.put(localPath, remotePath);

        return remotePath;
    }

    private async getFullRemotePath(relPath: string): Promise<string> {
        const homeDir = await this.getHomeDir();
        return `${this.getBasePath(homeDir)}/${relPath}`;
    }

    private getBasePath(home = '~'): string {
        return `${home}/.dev-server/${this.config.id}`;
    }

    private async getSftp(): Promise<SftpConnection> {
        const client = await this.getClient();
        if (!this.connectSftp) {
            const connection = new Promise<SftpConnection>((resolve, reject) => {
                client.sftp((err, sftp) => {
                    if (err) {
                        return reject(err);
                    }
                    resolve(new SftpConnection(sftp, this.log));
                });
            });
            this.connectSftp = connection;
            void connection.catch(() => {
                if (this.connectSftp === connection) {
                    this.connectSftp = undefined;
                }
            });
        }
        return this.connectSftp;
    }

    private async getClient(): Promise<SSHClient> {
        await this.connect();
        if (!this.client || this.connectState !== 'connected') {
            throw new Error('SSH client is not connected');
        }
        return this.client;
    }

    private isConnected(): boolean {
        return this.connectState === 'connected';
    }

    private handleDisconnect(client: SSHClient): void {
        if (this.client !== client) {
            return;
        }
        this.connectState = 'disconnected';
        this.connectSftp = undefined;
        this.client = undefined;
        if (!this.intentionalClose) {
            this.log.warn('Remote SSH connection closed; the next operation will reconnect automatically.');
        }
    }

    private async getHomeDir(): Promise<string> {
        if (!this.homeDir) {
            this.homeDir = (await this.getExecOutput('echo $HOME')).trim();
        }
        return this.homeDir;
    }
}

class SftpConnection {
    private currentOperation?: Promise<any>;

    constructor(
        private sftp: SFTPWrapper,
        private log: Logger,
    ) {}

    public get(remotePath: string, localPath: string): Promise<void> {
        return this.run((resolve, reject) => {
            this.log.notice(`Transferring ${remotePath} from remote host...`);
            this.log.silly(`${remotePath} -> ${localPath}`);
            this.sftp.fastGet(remotePath, localPath, {}, putErr => {
                if (putErr) {
                    return reject(putErr);
                }
                resolve();
            });
        });
    }

    public put(localPath: string, remotePath: string): Promise<void> {
        return this.run((resolve, reject) => {
            this.log.notice(`Transferring ${localPath} to remote host...`);
            this.log.silly(`${localPath} -> ${remotePath}`);
            this.sftp.fastPut(localPath, remotePath, {}, putErr => {
                if (putErr) {
                    return reject(putErr);
                }
                resolve();
            });
        });
    }

    public readFile(remotePath: string): Promise<Buffer> {
        return this.run<Buffer>((resolve, reject) => {
            this.log.debug(`Reading ${remotePath} from remote host...`);
            this.sftp.readFile(remotePath, { encoding: 'utf8' }, (err, data) => {
                if (err) {
                    return reject(err);
                }
                resolve(data);
            });
        });
    }

    public writeFile(remotePath: string, data: Buffer | string): Promise<void> {
        return this.run((resolve, reject) => {
            this.log.debug(`Writing ${remotePath} to remote host...`);
            this.sftp.writeFile(remotePath, data, { encoding: 'utf8' }, err => {
                if (err) {
                    return reject(err);
                }
                resolve();
            });
        });
    }

    public exists(remotePath: string): Promise<boolean> {
        return this.run<boolean>(resolve => {
            this.log.silly(`Checking existence of remote file ${remotePath}...`);

            this.sftp.exists(remotePath, exists => {
                this.log.silly(`Remote file ${remotePath} exists: ${exists}`);
                resolve(exists);
            });
        });
    }

    public async unlink(remotePath: string): Promise<void> {
        return this.run((resolve, reject) => {
            this.log.notice(`Deleting remote file ${remotePath}...`);
            this.sftp.unlink(remotePath, err => {
                if (err) {
                    return reject(err);
                }
                resolve();
            });
        });
    }

    private async run<T = void>(
        executor: (resolve: (value: T) => void, reject: (reason?: any) => void) => void,
    ): Promise<T> {
        await this.currentOperation?.catch(() => undefined);

        const operation = new Promise<T>(executor);
        this.currentOperation = operation;

        return operation;
    }
}
