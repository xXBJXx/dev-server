import { DBConnection } from '@iobroker/testing/build/tests/integration/lib/dbConnection.js';
import chokidar from 'chokidar';
import fg from 'fast-glob';
import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import nodemon from 'nodemon';
import { ADAPTER_DEBUGGER_PORT, RunCommandBase } from './RunCommandBase.js';
import { OBJECTS_DB_PORT_OFFSET } from './CommandBase.js';
import { terminateProcessTreeGracefully } from './processTree.js';
import { RemoteConnection } from './RemoteConnection.js';
import { checkPort, delay } from './utils.js';
export class Watch extends RunCommandBase {
    startAdapter;
    noInstall;
    doNotWatch;
    useBrowserSync;
    fileWatchers = [];
    nodemonStarted = false;
    nodemonChildPids = new Set();
    restartTimer;
    ignoreConfigChangesUntil = 0;
    constructor(owner, startAdapter, noInstall, doNotWatch, useBrowserSync) {
        super(owner);
        this.startAdapter = startAdapter;
        this.noInstall = noInstall;
        this.doNotWatch = doNotWatch;
        this.useBrowserSync = useBrowserSync;
    }
    async doRun() {
        if (!this.noInstall) {
            await this.buildLocalAdapter();
            await this.installLocalAdapter();
        }
        if (this.isJSController()) {
            // this watches actually js-controller
            await this.startAdapterWatch();
            await this.startServer(this.useBrowserSync);
        }
        else {
            await this.prepareLocalProfileForWatch();
            await this.startJsController();
            await this.startServer(this.useBrowserSync);
            await this.startAdapterWatch();
        }
    }
    async prepareLocalProfileForWatch() {
        if (this.profileDir instanceof RemoteConnection) {
            return;
        }
        try {
            await checkPort(this.getPort(OBJECTS_DB_PORT_OFFSET));
        }
        catch {
            // The profile DB is not listening, so its files can safely be opened offline.
            const db = await this.startOfflineProfileDb();
            try {
                const id = `system.adapter.${this.adapterName}.0`;
                const instance = await db.getObject(id);
                if (instance?.common?.enabled) {
                    this.log.warn(`Disabling controller-managed ${this.adapterName}.0 before startup to prevent a duplicate adapter process.`);
                    // @ts-expect-error DBConnection uses wider ioBroker object types than this dynamically built ID
                    await db.setObject(id, {
                        ...instance,
                        common: { ...instance.common, enabled: false },
                    });
                }
                // A previously interrupted development session may have left these
                // transient states at true. No controller is running at this point.
                for (const adapter of ['admin', this.adapterName]) {
                    await db.setState(`system.adapter.${adapter}.0.alive`, { val: false, ack: true });
                    await db.setState(`system.adapter.${adapter}.0.connected`, { val: false, ack: true });
                }
            }
            finally {
                await db.stop();
            }
            return;
        }
        throw new Error(`The dev-server profile "${this.owner.profileName}" is already running on objects DB port ` +
            `${this.getPort(OBJECTS_DB_PORT_OFFSET)}. Stop the other dev-server process before starting watch again.`);
    }
    async startOfflineProfileDb() {
        const dataDir = path.join(this.profilePath, 'iobroker-data');
        const lockFiles = ['objects.jsonl.lock', 'states.jsonl.lock'].map(file => path.join(dataDir, file));
        const existingLocks = (await Promise.all(lockFiles.map(async (lockFile) => {
            try {
                return { lockFile, lockStat: await stat(lockFile) };
            }
            catch (error) {
                if (error?.code === 'ENOENT') {
                    return undefined;
                }
                throw error;
            }
        }))).filter(lock => lock !== undefined);
        if (existingLocks.length) {
            // Give a concurrently starting controller time to open its DB port.
            await delay(2000);
            let profileStarted = false;
            try {
                await checkPort(this.getPort(OBJECTS_DB_PORT_OFFSET));
                profileStarted = true;
            }
            catch {
                // The port is still free.
            }
            if (profileStarted) {
                throw new Error(`The dev-server profile "${this.owner.profileName}" started while checking its database locks.`);
            }
            for (const { lockFile, lockStat } of existingLocks) {
                if (!lockStat.isDirectory() || (await readdir(lockFile)).length > 0) {
                    throw new Error(`Refusing to remove unexpected database lock contents: ${lockFile}`);
                }
                if (Date.now() - lockStat.mtimeMs < 10_000) {
                    throw new Error(`Database lock is still fresh: ${lockFile}`);
                }
                await rm(lockFile, { recursive: true, force: true });
                this.log.warn(`Removed stale database lock ${lockFile}`);
            }
        }
        const db = new DBConnection('iobroker', this.profilePath, this.log);
        await db.start();
        return db;
    }
    async startAdapterWatch() {
        // figure out if we need to watch for TypeScript changes
        const pkg = await this.readPackageJson();
        const scripts = pkg.scripts;
        if (scripts && scripts['watch:ts']) {
            this.log.notice(`Starting TypeScript watch: ${this.startAdapter}`);
            // use TSC
            await this.startTscWatch();
        }
        const isTypeScriptMain = this.isTypeScriptMain(pkg.main);
        const mainFileSuffix = pkg.main.split('.').pop();
        // start sync
        const adapterRunDir = path.join('node_modules', `iobroker.${this.adapterName}`);
        if (!this.config.useSymlinks) {
            this.log.notice('Starting file synchronization');
            // This is not necessary when using symlinks
            await this.startFileSync(adapterRunDir, mainFileSuffix);
            this.log.notice('File synchronization ready');
        }
        if (this.startAdapter) {
            await delay(3000);
            await this.startNodemon(adapterRunDir, pkg.main);
        }
        else {
            const runner = isTypeScriptMain ? 'node -r @alcalzone/esbuild-register' : 'node';
            this.log.box(`You can now start the adapter manually by running\n    ` +
                `${runner} node_modules/iobroker.${this.adapterName}/${pkg.main} --debug 0\nfrom within\n    ${this.profilePath}`);
        }
    }
    async startTscWatch() {
        this.log.notice('Starting tsc --watch');
        this.log.debug('Waiting for first successful tsc build...');
        await this.rootDir.spawnNpmAndAwaitOutput(['run', 'watch:ts'], /watching (files )?for/i);
    }
    startFileSync(destinationDir, mainFileSuffix) {
        this.log.debug(`Starting file system sync from ${this.rootPath} to ${destinationDir}`);
        const inSrc = (filename) => path.join(this.rootPath, filename);
        const inDest = (filename) => path.join(destinationDir, filename);
        return new Promise((resolve, reject) => {
            const patternList = ['js', 'map'];
            if (!patternList.includes(mainFileSuffix)) {
                patternList.push(mainFileSuffix);
            }
            const patterns = this.getFilePatterns(patternList, true);
            const ignoreFiles = [];
            const watcher = chokidar.watch(fg.sync(patterns), { cwd: this.rootPath });
            this.fileWatchers.push(watcher);
            let ready = false;
            let initialEventPromises = [];
            watcher.on('error', reject);
            watcher.on('ready', async () => {
                this.log.debug('Initial scan complete. Ready for changes.');
                ready = true;
                await Promise.all(initialEventPromises);
                initialEventPromises = [];
                resolve();
            });
            /* For debugging:
            watcher.on('all', (event, path) => {
                console.log(event, path);
            });*/
            const syncFile = async (filename) => {
                try {
                    this.log.debug(`Synchronizing ${filename}`);
                    const src = inSrc(filename);
                    const dest = inDest(filename);
                    if (filename.endsWith('.ts')) {
                        // TypeScript loaders create their own sourcemaps. Appending a sourceMappingURL to
                        // the source file itself is invalid and makes esbuild-register emit a warning.
                        await this.profileDir.copyFileTo(src, dest);
                    }
                    else if (filename.endsWith('.map')) {
                        await this.patchSourcemap(src, dest);
                    }
                    else if (!existsSync(inSrc(`${filename}.map`))) {
                        // copy file and add sourcemap
                        await this.addSourcemap(src, dest, true);
                    }
                    else {
                        await this.profileDir.copyFileTo(src, dest);
                    }
                }
                catch {
                    this.log.warn(`Couldn't sync ${filename}`);
                }
            };
            watcher.on('add', async (filename) => {
                if (ready) {
                    await syncFile(filename);
                }
                else if (!filename.endsWith('.map') && !(await this.profileDir.exists(inDest(filename)))) {
                    // ignore files during initial sync if they don't exist in the target directory (except for sourcemaps)
                    this.log.silly(`Ignoring file ${filename}`);
                    ignoreFiles.push(filename);
                }
                else {
                    initialEventPromises.push(syncFile(filename));
                }
            });
            watcher.on('change', (filename) => {
                if (!ignoreFiles.includes(filename)) {
                    const resPromise = syncFile(filename);
                    if (!ready) {
                        initialEventPromises.push(resPromise);
                    }
                }
            });
            watcher.on('unlink', async (filename) => {
                await this.profileDir.unlink(inDest(filename));
                const map = inDest(`${filename}.map`);
                if (await this.profileDir.exists(map)) {
                    await this.profileDir.unlink(map);
                }
            });
        });
    }
    startNodemon(baseDir, scriptName) {
        const fullBaseDir = path.resolve(this.profilePath, baseDir);
        const script = path.resolve(fullBaseDir, scriptName);
        this.log.notice(`Starting nodemon for ${script}`);
        nodemon(this.createNodemonConfig(script, fullBaseDir));
        this.nodemonStarted = true;
        nodemon
            .on('log', (msg) => {
            if (this.exiting) {
                return;
            }
            const message = `[nodemon] ${msg.message}`;
            switch (msg.type) {
                case 'detail':
                    this.log.debug(message);
                    void this.handleNodemonDetailMsg(msg.message);
                    break;
                case 'info':
                    this.log.info(message);
                    break;
                case 'status':
                    this.log.notice(message);
                    break;
                case 'fail':
                    this.log.error(message);
                    break;
                case 'error':
                    this.log.warn(message);
                    break;
                default:
                    this.log.debug(message);
                    break;
            }
        })
            .on('quit', () => {
            this.log.error('nodemon has exited');
            return this.exit(-2);
        })
            .on('crash', () => {
            if (this.isJSController()) {
                this.log.debug('nodemon has exited as expected');
                return this.exit(-1);
            }
        });
        if (!this.isJSController()) {
            this.socketEvents.on('objectChange', (args) => {
                if (!Array.isArray(args) || args.length < 2 || args[0] !== `system.adapter.${this.adapterName}.0`) {
                    return;
                }
                if (Date.now() < this.ignoreConfigChangesUntil) {
                    return;
                }
                if (args[1]?.common?.enabled) {
                    if (this.restartTimer) {
                        clearTimeout(this.restartTimer);
                        this.restartTimer = undefined;
                    }
                    this.handleAdapterConfigChange(args[1]);
                    return;
                }
                if (this.restartTimer) {
                    clearTimeout(this.restartTimer);
                }
                this.restartTimer = setTimeout(() => {
                    this.handleAdapterConfigChange(args[1]);
                }, 300);
            });
        }
        return Promise.resolve();
    }
    handleAdapterConfigChange(instanceObject) {
        if (this.exiting) {
            return;
        }
        if (instanceObject?.common?.enabled) {
            this.log.warn(`The controller-managed ${this.adapterName}.0 instance was enabled while watch mode is running. ` +
                'Disabling it to stop a duplicate-process restart loop.');
            this.ignoreConfigChangesUntil = Date.now() + 2000;
            this.sendSocketEvent('setObject', [
                `system.adapter.${this.adapterName}.0`,
                {
                    ...instanceObject,
                    common: { ...instanceObject.common, enabled: false },
                },
            ], true);
            return;
        }
        if (!this.exiting) {
            this.log.notice('Adapter configuration changed, restarting nodemon...');
            nodemon.restart();
        }
    }
    async stopRuntime() {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = undefined;
        }
        await Promise.all(this.fileWatchers.map(watcher => watcher.close()));
        this.fileWatchers.length = 0;
        if (this.nodemonStarted) {
            this.nodemonStarted = false;
            nodemon.removeAllListeners('quit');
            nodemon.emit('quit');
            await Promise.all([...this.nodemonChildPids].map(pid => terminateProcessTreeGracefully(pid)));
            this.nodemonChildPids.clear();
            nodemon.removeAllListeners('log');
            nodemon.removeAllListeners('crash');
            nodemon.removeAllListeners('quit');
        }
    }
    createNodemonConfig(script, fullBaseDir) {
        const args = this.isJSController() ? [] : ['--debug', '0'];
        const ignoreList = [
            path.join(fullBaseDir, 'admin'),
            // avoid recursively following symlinks
            path.join(fullBaseDir, '.dev-server'),
        ];
        if (this.doNotWatch.length > 0) {
            this.doNotWatch.forEach(entry => ignoreList.push(path.join(fullBaseDir, entry)));
        }
        // Determine the appropriate execMap
        const execMap = {
            js: 'node --inspect --preserve-symlinks --preserve-symlinks-main',
            mjs: 'node --inspect --preserve-symlinks --preserve-symlinks-main',
            ts: 'node --inspect --preserve-symlinks --preserve-symlinks-main -r @alcalzone/esbuild-register',
        };
        return {
            script,
            cwd: fullBaseDir,
            stdin: false,
            verbose: true,
            // dump: true, // this will output the entire config and not do anything
            colours: false,
            watch: [fullBaseDir],
            ignore: ignoreList,
            ignoreRoot: [],
            delay: 2000,
            execMap,
            signal: 'SIGINT',
            args,
        };
    }
    async handleNodemonDetailMsg(message) {
        const match = message.match(/child pid: (\d+)/);
        if (!match) {
            return;
        }
        const childPid = parseInt(match[1]);
        this.nodemonChildPids.add(childPid);
        let debugPid;
        try {
            debugPid = await this.waitForNodeChildProcess(childPid);
        }
        catch (error) {
            // ps-tree may not understand the process-list output of brand-new
            // Windows/Node.js versions. The inspector port remains stable and
            // can still be used to attach the debugger.
            this.log.warn(`Couldn't determine nodemon child process: ${error}`);
            this.log.box(`Debugger is now available on 127.0.0.1:${ADAPTER_DEBUGGER_PORT}`);
            return;
        }
        this.log.box(`Debugger is now available on process id ${debugPid}`);
    }
}
