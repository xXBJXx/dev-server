import chokidar from 'chokidar';
import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const CLIENT_PATH = '/__dev_server_reload/events';
const LIVE_RELOAD_CLIENT = `<script data-dev-server-live-reload>
(() => {
    const source = new EventSource('${CLIENT_PATH}');
    source.addEventListener('reload', () => window.location.reload());
})();
</script>`;
export function injectLiveReloadClient(html) {
    if (html.includes('data-dev-server-live-reload')) {
        return html;
    }
    return html.match(/<\/body\s*>/i)
        ? html.replace(/<\/body\s*>/i, `${LIVE_RELOAD_CLIENT}</body>`)
        : `${html}${LIVE_RELOAD_CLIENT}`;
}
export class LiveReloadServer {
    rootPath;
    port;
    reloadDelay;
    log;
    server;
    watchers = [];
    clients = new Map();
    reloadTimer;
    constructor(rootPath, port, reloadDelay, log) {
        this.rootPath = rootPath;
        this.port = port;
        this.reloadDelay = reloadDelay;
        this.log = log;
    }
    async start() {
        const app = express();
        app.get(CLIENT_PATH, (req, res) => this.addClient(req, res));
        app.use((req, res, next) => void this.serveHtml(req, res, next));
        app.use(express.static(this.rootPath));
        await new Promise((resolve, reject) => {
            const server = app.listen(this.port, '127.0.0.1');
            this.server = server;
            server.once('listening', resolve);
            server.once('error', reject);
        });
        const watcher = chokidar.watch(this.rootPath, { ignoreInitial: true });
        watcher.on('all', () => this.scheduleReload());
        this.watchers.push(watcher);
        await new Promise((resolve, reject) => {
            watcher.once('ready', resolve);
            watcher.once('error', reject);
        });
    }
    get listeningPort() {
        const address = this.server?.address();
        if (!address || typeof address === 'string') {
            throw new Error('Live-reload server is not listening');
        }
        return address.port;
    }
    watch(filePath, callback) {
        const watcher = chokidar.watch(filePath, { ignoreInitial: true });
        watcher.on('all', event => {
            void Promise.resolve(callback(event)).catch(error => this.log.warn(`Live-reload file callback failed for ${filePath}: ${error}`));
        });
        this.watchers.push(watcher);
    }
    async close() {
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
            this.reloadTimer = undefined;
        }
        for (const [response, heartbeat] of this.clients) {
            clearInterval(heartbeat);
            response.end();
        }
        this.clients.clear();
        await Promise.all(this.watchers.map(async (watcher) => await watcher.close()));
        this.watchers.length = 0;
        const server = this.server;
        this.server = undefined;
        if (server) {
            await new Promise(resolve => server.close(() => resolve()));
        }
    }
    addClient(req, res) {
        res.set({
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'Content-Type': 'text/event-stream',
        });
        res.flushHeaders();
        res.write(': connected\n\n');
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
        this.clients.set(res, heartbeat);
        req.once('close', () => {
            clearInterval(heartbeat);
            this.clients.delete(res);
        });
    }
    async serveHtml(req, res, next) {
        if (req.method !== 'GET') {
            return next();
        }
        const relativePath = req.path === '/' ? 'index.html' : req.path.replace(/^\/+/, '');
        if (!relativePath.toLowerCase().endsWith('.html')) {
            return next();
        }
        const root = path.resolve(this.rootPath);
        const filePath = path.resolve(root, relativePath);
        if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
            res.status(403).end();
            return;
        }
        try {
            const html = await readFile(filePath, 'utf8');
            res.type('html').send(injectLiveReloadClient(html));
        }
        catch (error) {
            if (error?.code === 'ENOENT') {
                return next();
            }
            this.log.warn(`Could not serve live-reload HTML ${filePath}: ${error}`);
            next(error);
        }
    }
    scheduleReload() {
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
        }
        this.reloadTimer = setTimeout(() => {
            this.reloadTimer = undefined;
            for (const response of this.clients.keys()) {
                response.write('event: reload\ndata: reload\n\n');
            }
        }, this.reloadDelay);
    }
}
