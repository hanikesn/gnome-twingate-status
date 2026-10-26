// Exercises TwingateSocketClient against an in-process fake daemon.
// Run with `pnpm test`. Exits non-zero on the first failed assertion.
import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import system from 'system';
import { TwingateSocketClient } from '../TwingateSocketClient.js';
import type * as Twingate from '../TwingateTypes.js';

const RECONNECT_MS = 100;
const STEP_TIMEOUT_MS = 3000;

class FakeDaemon {
    readonly path: string;
    private readonly _listener = new Gio.SocketListener();
    private readonly _dir: string;
    private _pendingAccept: ((conn: Gio.SocketConnection) => void) | null = null;
    private _accepted: Gio.SocketConnection[] = [];

    constructor() {
        this._dir = GLib.dir_make_tmp('twingate-test-XXXXXX');
        this.path = `${this._dir}/auth.sock`;
        const socket = Gio.Socket.new(Gio.SocketFamily.UNIX, Gio.SocketType.SEQPACKET, Gio.SocketProtocol.DEFAULT);
        socket.bind(Gio.UnixSocketAddress.new(this.path), true);
        socket.listen();
        this._listener.add_socket(socket, null);
        this._acceptLoop();
    }

    private _acceptLoop(): void {
        this._listener.accept_async(null, (listener, result) => {
            let conn: Gio.SocketConnection;
            try {
                [conn] = listener!.accept_finish(result);
            } catch {
                // Listener closed; the test is over.
                return;
            }
            if (this._pendingAccept) {
                const resolve = this._pendingAccept;
                this._pendingAccept = null;
                resolve(conn);
            } else {
                this._accepted.push(conn);
            }
            this._acceptLoop();
        });
    }

    nextConnection(): Promise<Gio.SocketConnection> {
        const queued = this._accepted.shift();
        if (queued) return Promise.resolve(queued);
        return withTimeout(new Promise((resolve) => (this._pendingAccept = resolve)), 'accept');
    }

    send(conn: Gio.SocketConnection, packet: unknown): void {
        const text = typeof packet === 'string' ? packet : JSON.stringify(packet);
        conn.get_output_stream().write_bytes(new TextEncoder().encode(text), null);
    }

    receive(conn: Gio.SocketConnection): Promise<unknown> {
        return withTimeout(
            new Promise((resolve, reject) => {
                conn.get_input_stream().read_bytes_async(65536, GLib.PRIORITY_DEFAULT, null, (stream, result) => {
                    try {
                        const bytes = stream!.read_bytes_finish(result).toArray();
                        resolve(JSON.parse(new TextDecoder().decode(bytes)));
                    } catch (e) {
                        reject(e);
                    }
                });
            }),
            'receive',
        );
    }

    close(): void {
        this._listener.close();
        GLib.unlink(this.path);
        GLib.rmdir(this._dir);
    }
}

function withTimeout<T>(promise: Promise<T>, what: string, ms = STEP_TIMEOUT_MS): Promise<T> {
    return new Promise((resolve, reject) => {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            reject(new Error(`timeout waiting for ${what}`));
            return GLib.SOURCE_REMOVE;
        });
        promise.then(
            (v) => {
                GLib.Source.remove(id);
                resolve(v);
            },
            (e) => {
                GLib.Source.remove(id);
                reject(e);
            },
        );
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) =>
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }),
    );
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`assertion failed: ${message}`);
}

const quietLogger = {
    log() {},
    info() {},
    debug() {},
    warn() {},
    error() {},
    trace() {},
    group() {},
    groupEnd() {},
    assert() {},
    count() {},
    countReset() {},
    dir() {},
    dirxml() {},
    table() {},
    time() {},
    timeEnd() {},
    timeLog() {},
};

async function main(): Promise<void> {
    const daemon = new FakeDaemon();
    const events: string[] = [];
    let waiters: { pred: (events: string[]) => boolean; resolve: () => void }[] = [];
    const messages: Twingate.Message[] = [];

    const record = (event: string) => {
        events.push(event);
        waiters = waiters.filter((w) => {
            if (!w.pred(events)) return true;
            w.resolve();
            return false;
        });
    };
    const until = (what: string, pred: (events: string[]) => boolean) =>
        withTimeout(
            new Promise<void>((resolve) => {
                if (pred(events)) resolve();
                else waiters.push({ pred, resolve });
            }),
            what,
        );

    const client = new TwingateSocketClient(
        quietLogger,
        {
            onConnected: () => {
                record('connected');
                client.sendCommand({ cmd: 'resources' });
            },
            onDisconnected: () => record('disconnected'),
            onError: (e) => record(`error:${e}`),
            onMessage: (m) => {
                messages.push(m);
                record('message');
            },
        },
        { socketPath: daemon.path, reconnectDelayMs: RECONNECT_MS },
    );

    try {
        // 1. Service active: client connects and asks for resources.
        client.serviceActive();
        const conn1 = await daemon.nextConnection();
        const first = (await daemon.receive(conn1)) as { cmd: string };
        assert(first.cmd === 'resources', 'first packet is the resources request');
        assert(JSON.stringify(messages) === '[]', 'no messages before daemon speaks');
        assert(client.isConnected(), 'client reports connected');
        console.log('ok  connects and sends resources request');

        // 2. A resources payload larger than the default read buffer is
        // delivered intact because the header announces its size.
        const resources = Array.from({ length: 600 }, (_, i) => ({
            id: String(i),
            name: `Resource ${i}`,
            address: `host-${i}.example.internal`,
            auth_state: 'none',
            auth_expires_at: 0,
            client_visibility: 1,
            open_url: null,
            can_open_in_browser: false,
        }));
        const payload = JSON.stringify({ resources, user: { email: 'test@example.com' } });
        assert(payload.length > 64 * 1024, 'payload exceeds the default 64 KiB read');
        daemon.send(conn1, { cmd: 'status', msg: 'Online', details: 'User', internet_security: 0 });
        daemon.send(conn1, { cmd: 'resources', 'content-length': payload.length });
        daemon.send(conn1, payload);
        await until('resources payload', () => messages.length >= 3);
        const received = messages[2] as Twingate.ResourceMessage;
        assert(!('cmd' in received), 'third message is the payload');
        assert(received.resources.length === 600, `payload intact, got ${received.resources.length} resources`);
        assert(received.user?.email === 'test@example.com', 'user carried through');
        console.log('ok  oversized payload is read whole');

        // 3. Commands go out as single JSON packets.
        client.sendCommand({ cmd: 'auth', resource: 'Resource 7' });
        const cmd = (await daemon.receive(conn1)) as { cmd: string; resource: string };
        assert(cmd.cmd === 'auth' && cmd.resource === 'Resource 7', 'auth command delivered');
        console.log('ok  auth command delivered');

        // 4. Daemon closes the socket: client reports it and reconnects.
        conn1.close(null);
        await until('disconnect', (e) => e.includes('disconnected'));
        assert(!client.isConnected(), 'client reports disconnected');
        const conn2 = await daemon.nextConnection();
        await daemon.receive(conn2);
        await until('reconnect', (e) => e.filter((x) => x === 'connected').length >= 2);
        console.log('ok  reconnects after the daemon drops the connection');

        // 5. Service inactive: no reconnect attempts.
        client.serviceInactive();
        assert(!client.isConnected(), 'disconnected when service goes inactive');
        conn2.close(null);
        let reconnected = false;
        daemon.nextConnection().then(
            () => (reconnected = true),
            () => {},
        );
        await sleep(RECONNECT_MS * 4);
        assert(!reconnected, 'no reconnect while the service is inactive');
        console.log('ok  stays offline while the service is inactive');

        // 6. Service active again: a fresh connection is made.
        client.serviceActive();
        const conn3 = await daemon.nextConnection();
        await daemon.receive(conn3);
        console.log('ok  reconnects when the service becomes active again');
    } finally {
        client.destroy();
        daemon.close();
    }
}

// system.exit() unwinds by throwing, which a promise reaction would swallow,
// so the loop is quit first and the exit happens at top level.
const loop = new GLib.MainLoop(null, false);
let exitCode = 1;
main().then(
    () => {
        console.log('all tests passed');
        exitCode = 0;
        loop.quit();
    },
    (e) => {
        console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
        loop.quit();
    },
);
await loop.runAsync();
system.exit(exitCode);
