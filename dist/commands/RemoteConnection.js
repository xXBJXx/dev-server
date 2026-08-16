import enquirer from 'enquirer';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { Client as SSHClient } from 'ssh2';
import { exec as ssh2ExecAsync } from 'ssh2-exec/promises';
import { delay } from './utils.js';
export class RemoteConnection {
    config;
    log;
    clientFactory;
    client;
    connectState = 'disconnected';
    connectPromise;
    intentionalClose = false;
    childProcesses = [];
    tunnelServers = [];
    tunnelSockets = new Set();
    connectSftp;
    homeDir;
    signalHandler;
    constructor(config, log, clientFactory = () => new SSHClient()) {
        this.config = config;
        this.log = log;
        this.clientFactory = clientFactory;
    }
    async connect() {
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
        const attempt = new Promise((resolve, reject) => {
            const fail = (error) => {
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
            const connectConfig = {
                host: this.config.host,
                port: this.config.port,
                username: this.config.user,
            };
            if (this.config.privateKeyPath) {
                connectConfig.privateKey = readFileSync(this.config.privateKeyPath);
            }
            else {
                connectConfig.tryKeyboard = true;
                client.on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
                    this.log.notice(instructions);
                    async function askPassword() {
                        const result = [];
                        for (const p of prompts) {
                            const answer = await enquirer.prompt({
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
        }
        finally {
            if (this.connectPromise === attempt) {
                this.connectPromise = undefined;
            }
        }
        if (this.client !== client || !this.isConnected()) {
            throw new Error('SSH connection closed immediately after authentication');
        }
        this.log.debug('Remote SSH connection established');
        if (!this.signalHandler) {
            this.signalHandler = () => void this.exitChildProcesses('SIGINT').catch(e => this.log.silly(`Couldn't exit child processes: ${e.message}`));
            process.on('SIGINT', this.signalHandler);
        }
    }
    close() {
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
    async readFile(relPath) {
        const remotePath = await this.getFullRemotePath(relPath);
        const sftp = await this.getSftp();
        const buffer = await sftp.readFile(remotePath);
        return buffer.toString();
    }
    async writeFile(relPath, data) {
        const remotePath = await this.getFullRemotePath(relPath);
        const sftp = await this.getSftp();
        await sftp.writeFile(remotePath, data);
    }
    async readJson(relPath) {
        const content = await this.readFile(relPath);
        return JSON.parse(content);
    }
    async writeJson(relPath, data) {
        const content = JSON.stringify(data, null, 2);
        return this.writeFile(relPath, content);
    }
    async copyFileTo(src, dest) {
        await this.upload(src, dest);
    }
    async exists(relPath) {
        const remotePath = await this.getFullRemotePath(relPath);
        const sftp = await this.getSftp();
        return sftp.exists(remotePath);
    }
    async unlink(relPath) {
        const remotePath = await this.getFullRemotePath(relPath);
        const sftp = await this.getSftp();
        await sftp.unlink(remotePath);
    }
    async spawn(command, args, onExit) {
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
                stream.once('data', (data) => {
                    const match = data.toString().match(/PID=>(\d+)</);
                    if (match) {
                        const pid = parseInt(match[1], 10);
                        this.log.silly(`Spawned remote process with PID ${pid}`);
                        this.childProcesses.push(pid);
                    }
                });
                stream.on('close', (code) => {
                    onExit(code ?? 1)?.catch((e) => this.log.error(`Error in onExit handler: ${e.message}`));
                });
                stream.pipe(process.stdout, { end: false });
                stream.stderr.pipe(process.stderr, { end: false });
            });
        });
    }
    async exec(command) {
        const client = await this.getClient();
        const basePath = this.getBasePath();
        this.log.debug(`${this.config.user}@${this.config.host}:${basePath}> ${command}`);
        command = this.asBashCommand(`cd ${basePath} ; ${command}`);
        return new Promise((resolve, reject) => {
            client.exec(command, { pty: true }, (err, stream) => {
                if (err) {
                    return reject(err);
                }
                stream.on('close', (code, signal) => {
                    if (code === 0) {
                        resolve();
                    }
                    else {
                        reject(new Error(`Command failed with code ${code} (${signal})`));
                    }
                });
                stream.pipe(process.stdout, { end: false });
                stream.stderr.pipe(process.stderr, { end: false });
            });
        });
    }
    async execWithExistingFile(fullPath, commandBuilder) {
        const filename = path.basename(fullPath);
        const remotePath = await this.upload(fullPath, filename);
        await this.exec(commandBuilder(remotePath));
    }
    async execWithNewFile(localPath, commandBuilder) {
        const filename = path.basename(localPath);
        const remotePath = await this.getFullRemotePath(filename);
        await this.exec(commandBuilder(remotePath));
        const sftp = await this.getSftp();
        await sftp.get(remotePath, localPath);
        await this.exec(`rm -f "${remotePath}"`);
    }
    async getExecOutput(command) {
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
    asBashCommand(command) {
        command = `/usr/bin/bash -lic '${command.replace(/'/g, "'\\''")}'`;
        this.log.silly(`Remote command: ${command}`);
        return command;
    }
    async exitChildProcesses(signal) {
        if (signal === 'SIGKILL') {
            this.close();
        }
        else if (this.childProcesses.length > 0) {
            const pids = [...this.childProcesses];
            this.childProcesses.length = 0;
            for (const pid of pids) {
                try {
                    await this.getExecOutput(`kill -s ${signal} ${pid}`);
                }
                catch (err) {
                    this.log.silly(`Failed to send ${signal} to remote process ${pid}: ${err}`);
                }
            }
            // first try SIGINT and give it 5s to exit itself before killing the processes left
            await delay(5000);
            await this.exitChildProcesses('SIGKILL');
        }
    }
    sendSigIntToChildProcesses() {
        // this method is only used locally when there is no TTY
        this.close();
    }
    async tunnelPort(port) {
        this.log.notice(`Preparing tunnel for port ${port}...`);
        const server = createServer(sock => {
            this.tunnelSockets.add(sock);
            sock.once('close', () => this.tunnelSockets.delete(sock));
            sock.pause();
            this.log.silly(`Client connected to port ${port}, opening tunnel...`);
            void this.getClient()
                .then(client => client.forwardOut('127.0.0.1', port, '127.0.0.1', port, (err, stream) => {
                if (err) {
                    this.log.silly(`forwardOut for port ${port} failed: ${err.message}`);
                    sock.destroy();
                    return;
                }
                this.log.silly(`Tunnel for port ${port} established (${sock.remoteAddress}:${sock.remotePort}).`);
                sock.pipe(stream);
                stream.pipe(sock);
                sock.resume();
            }))
                .catch(error => {
                this.log.silly(`Could not reconnect tunnel for port ${port}: ${error}`);
                sock.destroy();
            });
        });
        this.tunnelServers.push(server);
        return new Promise((resolve, reject) => {
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
    async upload(localPath, relPath) {
        const remotePath = await this.getFullRemotePath(relPath);
        const sftp = await this.getSftp();
        await sftp.put(localPath, remotePath);
        return remotePath;
    }
    async getFullRemotePath(relPath) {
        const homeDir = await this.getHomeDir();
        return `${this.getBasePath(homeDir)}/${relPath}`;
    }
    getBasePath(home = '~') {
        return `${home}/.dev-server/${this.config.id}`;
    }
    async getSftp() {
        const client = await this.getClient();
        if (!this.connectSftp) {
            const connection = new Promise((resolve, reject) => {
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
    async getClient() {
        await this.connect();
        if (!this.client || this.connectState !== 'connected') {
            throw new Error('SSH client is not connected');
        }
        return this.client;
    }
    isConnected() {
        return this.connectState === 'connected';
    }
    handleDisconnect(client) {
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
    async getHomeDir() {
        if (!this.homeDir) {
            this.homeDir = (await this.getExecOutput('echo $HOME')).trim();
        }
        return this.homeDir;
    }
}
class SftpConnection {
    sftp;
    log;
    currentOperation;
    constructor(sftp, log) {
        this.sftp = sftp;
        this.log = log;
    }
    get(remotePath, localPath) {
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
    put(localPath, remotePath) {
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
    readFile(remotePath) {
        return this.run((resolve, reject) => {
            this.log.debug(`Reading ${remotePath} from remote host...`);
            this.sftp.readFile(remotePath, { encoding: 'utf8' }, (err, data) => {
                if (err) {
                    return reject(err);
                }
                resolve(data);
            });
        });
    }
    writeFile(remotePath, data) {
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
    exists(remotePath) {
        return this.run(resolve => {
            this.log.silly(`Checking existence of remote file ${remotePath}...`);
            this.sftp.exists(remotePath, exists => {
                this.log.silly(`Remote file ${remotePath} exists: ${exists}`);
                resolve(exists);
            });
        });
    }
    async unlink(remotePath) {
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
    async run(executor) {
        await this.currentOperation?.catch(() => undefined);
        const operation = new Promise(executor);
        this.currentOperation = operation;
        return operation;
    }
}
