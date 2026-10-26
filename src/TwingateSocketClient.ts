import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import type * as Twingate from './TwingateTypes.js';
import type { ConsoleLike } from '@girs/gnome-shell/extensions/extension';
import { errorMessage } from './helpers.js';

export const DEFAULT_SOCKET_PATH = '/run/twingate/auth.sock';
const DEFAULT_READ_SIZE = 64 * 1024;
// Slack added on top of an announced content-length so the following packet
// is never truncated by an off-by-a-few header count.
const READ_SIZE_MARGIN = 4096;
const DEFAULT_RECONNECT_DELAY_MS = 5000;

export type SocketClientOptions = {
    socketPath?: string;
    reconnectDelayMs?: number;
};

export type SocketEventCallbacks = {
    onConnected?: () => void;
    onMessage?: (message: Twingate.Message) => void;
    onError?: (error: string) => void;
    onDisconnected?: () => void;
};

/**
 * Client for the Twingate daemon's SOCK_SEQPACKET socket.
 *
 * Every packet is one JSON document. The daemon announces a large payload with
 * a `{"cmd":"resources","content-length":N}` header packet, which is used to
 * size the next read: a SEQPACKET read that is shorter than the packet silently
 * discards the rest.
 */
export class TwingateSocketClient {
    private _connection: Gio.SocketConnection | null = null;
    private _cancellable: Gio.Cancellable | null = null;
    private _reconnectTimeoutId: number | null = null;
    private _connecting = false;
    private _serviceActive = false;
    private _nextReadSize = DEFAULT_READ_SIZE;
    private readonly _decoder = new TextDecoder('utf-8');
    private readonly _encoder = new TextEncoder();
    private readonly _socketPath: string;
    private readonly _reconnectDelayMs: number;

    constructor(
        private readonly _logger: ConsoleLike,
        private readonly _callbacks: SocketEventCallbacks,
        options: SocketClientOptions = {},
    ) {
        this._socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
        this._reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    }

    isConnected(): boolean {
        return this._connection !== null;
    }

    serviceActive(): void {
        this._serviceActive = true;
        if (!this.isConnected() && !this._connecting) this._connect();
    }

    serviceInactive(): void {
        this._serviceActive = false;
        this._cancelReconnect();
        this._disconnect();
    }

    destroy(): void {
        this._serviceActive = false;
        this._cancelReconnect();
        this._disconnect();
    }

    sendCommand(command: Twingate.Commands): boolean {
        const stream = this._connection?.get_output_stream();
        if (!stream) {
            this._logger.warn('Cannot send command: not connected');
            return false;
        }

        try {
            stream.write_bytes(this._encoder.encode(JSON.stringify(command)), null);
            return true;
        } catch (e) {
            this._logger.error('Failed to send command:', errorMessage(e));
            this._callbacks.onError?.('Failed to send command');
            this._handleConnectionLoss();
            return false;
        }
    }

    private _connect(): void {
        this._connecting = true;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        const client = new Gio.SocketClient({
            family: Gio.SocketFamily.UNIX,
            type: Gio.SocketType.SEQPACKET,
        });

        client.connect_async(Gio.UnixSocketAddress.new(this._socketPath), cancellable, (_source, result) => {
            this._connecting = false;
            let connection: Gio.SocketConnection;
            try {
                connection = client.connect_finish(result);
            } catch (e) {
                if (cancellable.is_cancelled()) return;
                this._logger.warn('Failed to connect to Twingate socket:', errorMessage(e));
                this._callbacks.onError?.('Connection failed');
                this._scheduleReconnect();
                return;
            }

            this._connection = connection;
            this._nextReadSize = DEFAULT_READ_SIZE;
            this._logger.debug('Connected to Twingate socket');
            this._readNext(connection, cancellable);
            this._callbacks.onConnected?.();
        });
    }

    private _readNext(connection: Gio.SocketConnection, cancellable: Gio.Cancellable): void {
        const readSize = this._nextReadSize;
        this._nextReadSize = DEFAULT_READ_SIZE;

        connection
            .get_input_stream()
            .read_bytes_async(readSize, GLib.PRIORITY_DEFAULT, cancellable, (stream, result) => {
                if (cancellable.is_cancelled() || !stream) return;

                let data: Uint8Array;
                try {
                    data = stream.read_bytes_finish(result).toArray();
                } catch (e) {
                    this._logger.error('Error reading from Twingate socket:', errorMessage(e));
                    this._callbacks.onError?.('Error reading from socket');
                    this._handleConnectionLoss();
                    return;
                }

                if (data.length === 0) {
                    this._logger.info('Twingate socket closed by peer');
                    this._handleConnectionLoss();
                    return;
                }
                if (data.length === readSize) {
                    this._logger.warn(`Packet filled the ${readSize} byte read buffer; it may have been truncated`);
                }

                this._handlePacket(this._decoder.decode(data));
                this._readNext(connection, cancellable);
            });
    }

    private _handlePacket(text: string): void {
        let message: Twingate.Message;
        try {
            message = JSON.parse(text) as Twingate.Message;
        } catch (e) {
            this._logger.error('Failed to parse message:', errorMessage(e));
            this._callbacks.onError?.('Failed to parse message');
            return;
        }

        if ('cmd' in message && message.cmd === 'resources' && typeof message['content-length'] === 'number') {
            this._nextReadSize = Math.max(DEFAULT_READ_SIZE, message['content-length'] + READ_SIZE_MARGIN);
        }

        this._callbacks.onMessage?.(message);
    }

    private _disconnect(): void {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._connecting = false;

        const connection = this._connection;
        this._connection = null;
        if (connection) {
            try {
                connection.close(null);
            } catch (e) {
                this._logger.debug('Error closing socket:', errorMessage(e));
            }
        }
    }

    private _handleConnectionLoss(): void {
        if (!this.isConnected()) return;

        this._logger.info('Twingate socket connection lost');
        this._disconnect();
        this._callbacks.onDisconnected?.();
        this._scheduleReconnect();
    }

    private _scheduleReconnect(): void {
        if (!this._serviceActive) {
            this._logger.debug('Service is inactive, not reconnecting');
            return;
        }
        if (this._reconnectTimeoutId !== null) return;

        this._logger.info(`Reconnecting in ${this._reconnectDelayMs}ms`);
        this._reconnectTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._reconnectDelayMs, () => {
            this._reconnectTimeoutId = null;
            if (this._serviceActive && !this.isConnected()) this._connect();
            return GLib.SOURCE_REMOVE;
        });
    }

    private _cancelReconnect(): void {
        if (this._reconnectTimeoutId !== null) {
            GLib.Source.remove(this._reconnectTimeoutId);
            this._reconnectTimeoutId = null;
        }
    }
}
