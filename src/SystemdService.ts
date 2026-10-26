import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import type { ConsoleLike } from '@girs/gnome-shell/extensions/extension';
import { callProxy, getSystemdManager, getSystemdProxy, isDBusError } from './helpers.js';

export type ServiceState =
    | 'active'
    | 'reloading'
    | 'inactive'
    | 'failed'
    | 'activating'
    | 'deactivating'
    | 'maintenance'
    | 'refreshing'
    | 'unknown';

const SETTLED_STATES: ReadonlySet<ServiceState> = new Set(['active', 'inactive', 'failed']);

export interface ServiceStateHooks {
    onActive?: () => void;
    onInactive?: () => void;
    onFailed?: () => void;
}

/**
 * Watches a system unit over D-Bus and reports settled state changes.
 *
 * systemd only emits unit PropertiesChanged signals to connections that called
 * Manager.Subscribe(), and GetUnit fails for units that are not loaded (any unit
 * that is inactive and has been garbage-collected). LoadUnit returns the object
 * path in every case, so it is used instead.
 */
export class SystemdService {
    private _unitProxy: Gio.DBusProxy | null = null;
    private _signalId: number | null = null;
    private _debounceTimerId: number | null = null;
    private _pendingState: ServiceState | null = null;
    private _lastEmittedState: ServiceState | null = null;
    private _subscribed = false;
    private _cancellable: Gio.Cancellable | null = null;

    constructor(
        private readonly _serviceName: string,
        private readonly _logger: ConsoleLike,
        private readonly _hooks: ServiceStateHooks,
        private readonly _debounceMs: number = 2000,
    ) {}

    /** Last settled state the watcher reported, or null before the first check. */
    get state(): ServiceState | null {
        return this._lastEmittedState;
    }

    get isActive(): boolean {
        return this._lastEmittedState === 'active';
    }

    async startWatching(): Promise<void> {
        this.stopWatching();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        const manager = await getSystemdManager(cancellable);

        try {
            await callProxy(manager, 'Subscribe', null, Gio.DBusCallFlags.NONE, cancellable);
            this._subscribed = true;
        } catch (e) {
            // Another consumer on the shell's shared system bus connection already
            // subscribed; signals flow either way and we must not unsubscribe for them.
            if (!isDBusError(e, 'org.freedesktop.systemd1.AlreadySubscribed')) throw e;
        }

        const result = await callProxy(
            manager,
            'LoadUnit',
            new GLib.Variant('(s)', [this._serviceName]),
            Gio.DBusCallFlags.NONE,
            cancellable,
        );
        const unitPath = result.get_child_value(0).get_string()[0];

        const unitProxy = await getSystemdProxy(
            unitPath,
            'org.freedesktop.systemd1.Unit',
            Gio.DBusProxyFlags.NONE,
            cancellable,
        );
        if (cancellable.is_cancelled()) return;

        this._unitProxy = unitProxy;
        this._signalId = unitProxy.connect('g-properties-changed', () => this._onPropertiesChanged());
        this._logger.debug(`Watching unit ${unitPath}`);

        // Report the initial state without debouncing.
        this._emit(this._readState());
    }

    stopWatching(): void {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._clearDebounce();

        if (this._unitProxy && this._signalId !== null) {
            this._unitProxy.disconnect(this._signalId);
        }
        this._signalId = null;
        this._unitProxy = null;
        this._lastEmittedState = null;

        if (this._subscribed) {
            this._subscribed = false;
            getSystemdManager()
                .then((manager) => callProxy(manager, 'Unsubscribe', null))
                .catch((e) => this._logger.debug('Unsubscribe failed', e));
        }
    }

    start(): Promise<void> {
        return this._manage('StartUnit');
    }

    stop(): Promise<void> {
        return this._manage('StopUnit');
    }

    private async _manage(method: 'StartUnit' | 'StopUnit'): Promise<void> {
        const manager = await getSystemdManager();
        await callProxy(
            manager,
            method,
            new GLib.Variant('(ss)', [this._serviceName, 'replace']),
            Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION,
        );
    }

    private _readState(): ServiceState {
        const value = this._unitProxy?.get_cached_property('ActiveState')?.get_string()[0];
        return (value as ServiceState | undefined) ?? 'unknown';
    }

    private _onPropertiesChanged(): void {
        const state = this._readState();
        this._logger.debug(`Unit state changed: ${state}`);

        // Only the latest state matters: a restart passes through
        // deactivating/inactive/activating within the debounce window and
        // should surface as a single transition.
        this._clearDebounce();
        this._pendingState = state;
        this._debounceTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._debounceMs, () => {
            this._debounceTimerId = null;
            const pending = this._pendingState;
            this._pendingState = null;
            if (pending !== null) this._emit(pending);
            return GLib.SOURCE_REMOVE;
        });
    }

    private _emit(state: ServiceState): void {
        if (!SETTLED_STATES.has(state) || this._lastEmittedState === state) return;

        this._logger.info(`Unit ${this._serviceName} is ${state}`);
        this._lastEmittedState = state;

        switch (state) {
            case 'active':
                this._hooks.onActive?.();
                break;
            case 'inactive':
                this._hooks.onInactive?.();
                break;
            case 'failed':
                this._hooks.onFailed?.();
                break;
        }
    }

    private _clearDebounce(): void {
        if (this._debounceTimerId !== null) {
            GLib.Source.remove(this._debounceTimerId);
            this._debounceTimerId = null;
        }
        this._pendingState = null;
    }
}
