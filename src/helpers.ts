import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';

const SYSTEMD_BUS_NAME = 'org.freedesktop.systemd1';
const SYSTEMD_MANAGER_PATH = '/org/freedesktop/systemd1';
const SYSTEMD_MANAGER_IFACE = 'org.freedesktop.systemd1.Manager';

// Hand-rolled promise wrappers instead of Gio._promisify: the promisified
// overloads are untyped, so every call site needed a cast.
export function getSystemdProxy(
    objectPath: string,
    interfaceName: string,
    flags: Gio.DBusProxyFlags = Gio.DBusProxyFlags.NONE,
    cancellable: Gio.Cancellable | null = null,
    busType: Gio.BusType = Gio.BusType.SYSTEM,
): Promise<Gio.DBusProxy> {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new_for_bus(
            busType,
            flags,
            null,
            SYSTEMD_BUS_NAME,
            objectPath,
            interfaceName,
            cancellable,
            (_source, result) => {
                try {
                    resolve(Gio.DBusProxy.new_for_bus_finish(result));
                } catch (e) {
                    reject(e);
                }
            },
        );
    });
}

export function getSystemdManager(
    cancellable: Gio.Cancellable | null = null,
    busType: Gio.BusType = Gio.BusType.SYSTEM,
): Promise<Gio.DBusProxy> {
    return getSystemdProxy(SYSTEMD_MANAGER_PATH, SYSTEMD_MANAGER_IFACE, Gio.DBusProxyFlags.NONE, cancellable, busType);
}

/** ActiveState of a unit on the user's own systemd instance. */
export async function getUserUnitState(unit: string): Promise<string> {
    const manager = await getSystemdManager(null, Gio.BusType.SESSION);
    const result = await callProxy(manager, 'LoadUnit', new GLib.Variant('(s)', [unit]));
    const unitPath = result.get_child_value(0).get_string()[0];
    const proxy = await getSystemdProxy(
        unitPath,
        'org.freedesktop.systemd1.Unit',
        Gio.DBusProxyFlags.NONE,
        null,
        Gio.BusType.SESSION,
    );
    return proxy.get_cached_property('ActiveState')?.get_string()[0] ?? 'unknown';
}

/**
 * Masks and stops a user unit. Masking rather than disabling, because an
 * autostart entry may try to start it again at every login.
 */
export async function maskUserUnit(unit: string): Promise<void> {
    const manager = await getSystemdManager(null, Gio.BusType.SESSION);
    await callProxy(manager, 'MaskUnitFiles', new GLib.Variant('(asbb)', [[unit], false, true]));
    await callProxy(manager, 'Reload', null);
    await callProxy(manager, 'StopUnit', new GLib.Variant('(ss)', [unit, 'replace']));
}

export function callProxy(
    proxy: Gio.DBusProxy,
    method: string,
    args: GLib.Variant | null,
    flags: Gio.DBusCallFlags = Gio.DBusCallFlags.NONE,
    cancellable: Gio.Cancellable | null = null,
): Promise<GLib.Variant> {
    return new Promise((resolve, reject) => {
        proxy.call(method, args, flags, -1, cancellable, (_source, result) => {
            try {
                resolve(proxy.call_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function isDBusError(e: unknown, remoteName: string): boolean {
    return e instanceof GLib.Error && Gio.DBusError.get_remote_error(e) === remoteName;
}

export function errorMessage(e: unknown): string {
    if (e instanceof GLib.Error) {
        // Strip the "GDBus.Error:org.freedesktop.DBus.Error.X:" prefix D-Bus errors carry.
        Gio.DBusError.strip_remote_error(e);
        return e.message;
    }
    if (e instanceof Error) return e.message;
    return String(e);
}
