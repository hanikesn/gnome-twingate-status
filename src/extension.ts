import '@girs/gjs'; // For global types like `log()`
import '@girs/gjs/dom'; // For global types like `TextEncoder()`
import '@girs/gnome-shell/extensions/global'; // For global shell types
// St and Clutter change their GI version with every shell release (17 on
// GNOME 49, 18 on 50). Importing the unversioned modules keeps one bundle
// usable across releases; the ambient imports only supply types.
import '@girs/st-18/ambient';
import '@girs/clutter-18/ambient';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { type ConsoleLike, Extension, gettext as _, ngettext } from '@girs/gnome-shell/extensions/extension';
import { Button } from '@girs/gnome-shell/ui/panelMenu';
import * as Main from '@girs/gnome-shell/ui/main';
import * as PopupMenu from '@girs/gnome-shell/ui/popupMenu';
import * as MessageTray from '@girs/gnome-shell/ui/messageTray';

import GObject from '@girs/gobject-2.0';
import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import Pango from '@girs/pango-1.0';
import type * as Twingate from './TwingateTypes.js';
import { TwingateSocketClient } from './TwingateSocketClient.js';
import { SystemdService } from './SystemdService.js';
import { errorMessage, getUserUnitState, maskUserUnit } from './helpers.js';

type ConnectionState =
    | 'unavailable' // unit cannot be watched, Twingate is probably not installed
    | 'stopped' // unit inactive
    | 'failed' // unit failed
    | 'connecting' // unit active, no socket or daemon reports Offline
    | 'authenticating'
    | 'online';

// Enough to find anything by typing a little more; keeps the menu on screen.
const MAX_SEARCH_RESULTS = 10;
// Twingate's own desktop notifier; it shows the same sign-in prompts.
const NOTIFIER_UNIT = 'twingate-desktop-notifier.service';
// Auth expiry is only worth a line when it is about to bite.
const EXPIRY_WARNING_SECONDS = 2 * 60 * 60;

const STATE_LABELS: Record<ConnectionState, () => string> = {
    unavailable: () => _('Twingate not available'),
    stopped: () => _('Disconnected'),
    failed: () => _('Service failed'),
    connecting: () => _('Connecting…'),
    authenticating: () => _('Signing in…'),
    online: () => _('Connected'),
};

const INDICATOR_STYLE: Record<ConnectionState, string> = {
    unavailable: 'twingate-indicator-off',
    stopped: 'twingate-indicator-off',
    failed: 'twingate-indicator-off',
    connecting: 'twingate-indicator-connecting',
    authenticating: 'twingate-indicator-connecting',
    online: '',
};

const STATUS_ICONS: Record<ConnectionState, string> = {
    unavailable: 'dialog-warning-symbolic',
    stopped: 'network-vpn-disabled-symbolic',
    failed: 'dialog-error-symbolic',
    connecting: 'network-vpn-acquiring-symbolic',
    authenticating: 'dialog-password-symbolic',
    online: 'network-vpn-symbolic',
};

class ResourceItem extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    constructor(resource: Twingate.Resource, showAddress: boolean) {
        super();

        const needsAuth = resource.auth_state === 'pending';

        const labels = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        labels.add_child(ellipsized(new St.Label({ text: resource.name, y_align: Clutter.ActorAlign.CENTER })));

        let detail: string | null = null;
        const expiresIn = resource.auth_expires_at > 0 ? resource.auth_expires_at - GLib.get_real_time() / 1e6 : null;
        if (needsAuth) {
            detail = _('Authentication required');
        } else if (expiresIn !== null && expiresIn < EXPIRY_WARNING_SECONDS) {
            detail = _('Authentication expires in %s').format(formatDuration(expiresIn));
        } else if (showAddress && resource.address !== resource.name) {
            detail = resource.address;
        }
        if (detail) {
            labels.add_child(ellipsized(new St.Label({ text: detail, style_class: 'twingate-resource-address' })));
        }
        this.add_child(labels);

        let iconName = 'edit-copy-symbolic';
        if (needsAuth) iconName = 'dialog-password-symbolic';
        else if (resource.open_url) iconName = 'go-next-symbolic';
        this.add_child(
            new St.Icon({
                icon_name: iconName,
                style_class: 'popup-menu-icon twingate-trailing-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }),
        );
    }
}

// Long names and addresses must not widen the menu past the screen edge.
function ellipsized(label: St.Label): St.Label {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

function formatDuration(seconds: number): string {
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return ngettext('%d minute', '%d minutes', minutes).format(minutes);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const hoursText = ngettext('%d hour', '%d hours', hours).format(hours);
    return rest === 0 ? hoursText : `${hoursText} ${ngettext('%d minute', '%d minutes', rest).format(rest)}`;
}

class TwingateIndicator extends Button {
    static {
        GObject.registerClass(this);
    }

    private readonly _icon: St.Icon;
    private readonly _statusItem: PopupMenu.PopupImageMenuItem;
    private readonly _statusDetail: St.Label;
    private readonly _searchEntry: St.Entry;
    private readonly _resourcesSection: PopupMenu.PopupMenuSection;
    private readonly _controlServiceItem: PopupMenu.PopupMenuItem;
    private readonly _socketClient: TwingateSocketClient;
    private readonly _systemdService: SystemdService;
    private readonly _settingsSignals: number[] = [];

    private _state: ConnectionState = 'connecting';
    private _resources: Twingate.Resource[] = [];
    private _user: Twingate.User | null = null;
    private _notificationSource: MessageTray.Source | null = null;
    private _authNotification: MessageTray.Notification | null = null;
    // Set while the user triggered an auth flow from the menu, so the resulting
    // reauth URL opens directly instead of asking again via notification.
    private _userRequestedAuth = false;

    constructor(
        private readonly _logger: ConsoleLike,
        private readonly _settings: Gio.Settings,
        iconDir: string,
        openPreferences: () => void,
    ) {
        super(0.0, _('Twingate Status'));

        const menu = this.menu as PopupMenu.PopupMenu;
        menu.box.add_style_class_name('twingate-menu');

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${iconDir}/twingate-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._statusItem = new PopupMenu.PopupImageMenuItem('', STATUS_ICONS.connecting);
        this._statusItem.reactive = false;
        this._statusItem.can_focus = false;
        this._statusDetail = ellipsized(
            new St.Label({
                style_class: 'twingate-status-detail',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            }),
        );
        this._statusItem.add_child(this._statusDetail);
        menu.addMenuItem(this._statusItem);

        this._searchEntry = new St.Entry({
            style_class: 'twingate-search-entry',
            hint_text: _('Search resources'),
            can_focus: true,
            x_expand: true,
        });
        this._searchEntry.set_primary_icon(new St.Icon({ icon_name: 'edit-find-symbolic', icon_size: 16 }));
        this._searchEntry.clutter_text.connect('text-changed', () => this._renderResources());
        this._searchEntry.clutter_text.connect('activate', () => this._activateFirstMatch());
        const searchItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        searchItem.add_child(this._searchEntry);
        menu.addMenuItem(searchItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._resourcesSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._resourcesSection);

        this._controlServiceItem = new PopupMenu.PopupMenuItem(_('Connect'));
        this._controlServiceItem.connect('activate', () => this._toggleService());
        menu.addMenuItem(this._controlServiceItem);

        const settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
        settingsItem.connect('activate', () => openPreferences());
        menu.addMenuItem(settingsItem);

        menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._searchEntry.grab_key_focus();
            } else {
                this._searchEntry.set_text('');
            }
        });

        this._socketClient = new TwingateSocketClient(
            this._logger,
            {
                onConnected: () => {
                    this._setState('connecting');
                    this._socketClient.sendCommand({ cmd: 'resources' });
                },
                onDisconnected: () => {
                    this._updateResources([], null);
                    if (this._systemdService.isActive) this._setState('connecting');
                },
                onMessage: (message) => this._handleMessage(message),
            },
            { socketPath: this._settings.get_string('socket-path') },
        );

        this._systemdService = new SystemdService(this._settings.get_string('service-name'), this._logger, {
            onActive: () => {
                this._setState('connecting');
                this._socketClient.serviceActive();
            },
            onInactive: () => {
                this._socketClient.serviceInactive();
                this._updateResources([], null);
                this._setState('stopped');
            },
            onFailed: () => {
                this._socketClient.serviceInactive();
                this._updateResources([], null);
                this._setState('failed');
                this._notify(_('Service Failed'), _('The Twingate service has failed'), MessageTray.Urgency.HIGH);
            },
        });

        this._systemdService.startWatching().catch((e) => {
            this._logger.warn('Cannot watch the Twingate unit:', errorMessage(e));
            this._setState('unavailable');
        });

        for (const key of ['show-hidden-resources', 'show-addresses']) {
            this._settingsSignals.push(this._settings.connect(`changed::${key}`, () => this._renderResources()));
        }

        this._setState('connecting');
        this._checkNotifier().catch((e) => this._logger.debug('Notifier check failed:', errorMessage(e)));
    }

    // Both the extension and Twingate's notifier react to the same auth
    // socket, so the user gets every sign-in prompt twice until one is off.
    private async _checkNotifier(): Promise<void> {
        if (!this._settings.get_boolean('notifier-hint')) return;
        if ((await getUserUnitState(NOTIFIER_UNIT)) !== 'active') return;

        const notification = this._notify(
            _("Twingate's Notifier Is Also Running"),
            _('You will get every sign-in prompt twice. Disable the Twingate notifier to keep only this extension.'),
            MessageTray.Urgency.NORMAL,
            false,
        );
        notification.addAction(_('Disable Notifier'), () => {
            maskUserUnit(NOTIFIER_UNIT)
                .then(() => this._settings.set_boolean('notifier-hint', false))
                .catch((e) => {
                    this._logger.error('Failed to disable the Twingate notifier:', errorMessage(e));
                    this._notify(_('Could Not Disable Notifier'), errorMessage(e), MessageTray.Urgency.HIGH);
                });
        });
        notification.addAction(_("Don't Ask Again"), () => this._settings.set_boolean('notifier-hint', false));
    }

    override destroy() {
        for (const id of this._settingsSignals) this._settings.disconnect(id);
        this._settingsSignals.length = 0;
        this._systemdService.stopWatching();
        this._socketClient.destroy();
        this._authNotification?.destroy();
        this._authNotification = null;
        this._notificationSource?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._notificationSource = null;
        super.destroy();
    }

    // --- state -------------------------------------------------------------

    private _setState(state: ConnectionState): void {
        this._state = state;
        this._statusItem.label.text = STATE_LABELS[state]();
        this._statusItem.setIcon(STATUS_ICONS[state]);
        this._statusDetail.text = state === 'online' || state === 'authenticating' ? (this._user?.email ?? '') : '';

        for (const cls of Object.values(INDICATOR_STYLE)) if (cls) this._icon.remove_style_class_name(cls);
        if (INDICATOR_STYLE[state]) this._icon.add_style_class_name(INDICATOR_STYLE[state]);

        const serviceRunning = state === 'connecting' || state === 'authenticating' || state === 'online';
        this._controlServiceItem.label.text = serviceRunning ? _('Disconnect') : _('Connect');
        this._controlServiceItem.setSensitive(state !== 'unavailable');
    }

    private _setDaemonStatus(status: Twingate.Status): void {
        switch (status) {
            case 'Online':
                this._setState('online');
                break;
            case 'Authenticating':
                this._setState('authenticating');
                break;
            case 'Offline':
                this._updateResources([], null);
                this._setState(this._systemdService.isActive ? 'connecting' : 'stopped');
                break;
            default:
                this._logger.debug(`Unknown status ${status as string}`);
        }
    }

    // --- notifications -----------------------------------------------------

    // Created lazily so the source only shows up in the message tray once there
    // is something to say.
    private _getNotificationSource(): MessageTray.Source {
        if (!this._notificationSource) {
            const source = new MessageTray.Source({ title: _('Twingate VPN'), iconName: 'network-vpn-symbolic' });
            source.connect('destroy', () => {
                if (this._notificationSource === source) this._notificationSource = null;
            });
            Main.messageTray.add(source);
            this._notificationSource = source;
        }
        return this._notificationSource;
    }

    private _notify(
        title: string,
        body: string,
        urgency: MessageTray.Urgency,
        isTransient = urgency !== MessageTray.Urgency.HIGH,
    ): MessageTray.Notification {
        const source = this._getNotificationSource();
        const notification = new MessageTray.Notification({ source, title, body, urgency, isTransient });
        source.addNotification(notification);
        return notification;
    }

    // --- service control ---------------------------------------------------

    private async _toggleService(): Promise<void> {
        const stopping = this._systemdService.isActive;
        this._controlServiceItem.setSensitive(false);
        try {
            if (stopping) {
                await this._systemdService.stop();
            } else {
                await this._systemdService.start();
            }
        } catch (e) {
            const action = stopping ? _('Failed to Stop Service') : _('Failed to Start Service');
            this._logger.error(`${action}:`, errorMessage(e));
            this._notify(action, errorMessage(e), MessageTray.Urgency.HIGH);
        } finally {
            this._controlServiceItem.setSensitive(true);
        }
    }

    // --- daemon messages ---------------------------------------------------

    private _handleMessage(message: Twingate.Message): void {
        if (!('cmd' in message)) {
            if (Array.isArray(message.resources)) this._updateResources(message.resources, message.user);
            return;
        }

        switch (message.cmd) {
            case 'resources':
            case 'status-end':
                // Header and trailer packets; the payload arrives in between.
                break;
            case 'reauth':
                this._handleReauth(message);
                break;
            case 'auth-required':
                this._logger.debug(`Authentication required for ${message.name}`);
                // The resource list carries the auth state, refresh it.
                this._socketClient.sendCommand({ cmd: 'resources' });
                break;
            case 'auth-end':
                this._handleAuthEnd(message);
                break;
            case 'status':
                this._setDaemonStatus(message.msg);
                break;
            default:
                this._logger.debug('Unhandled message', message);
        }
    }

    private _handleReauth(msg: Twingate.ReAuthMessage): void {
        if (this._userRequestedAuth) {
            this._userRequestedAuth = false;
            this._openUri(msg.url);
            return;
        }

        this._authNotification?.destroy();

        const notification = new MessageTray.Notification({
            source: this._getNotificationSource(),
            title: _('Authentication Required'),
            body: _('Twingate needs you to sign in again'),
            urgency: MessageTray.Urgency.HIGH,
            isTransient: false,
            resident: true,
        });
        notification.connect('activated', () => this._openUri(msg.url));
        notification.addAction(_('Authenticate'), () => this._openUri(msg.url));
        notification.connect('destroy', () => {
            if (this._authNotification === notification) this._authNotification = null;
        });

        this._authNotification = notification;
        this._getNotificationSource().addNotification(notification);
    }

    private _handleAuthEnd(msg: Twingate.AuthEndMessage): void {
        this._userRequestedAuth = false;
        this._authNotification?.destroy();
        this._authNotification = null;
        if (msg.state) {
            this._logger.info('Authentication completed');
        } else {
            this._logger.warn(`Authentication failed: ${msg.reason}`);
            this._notify(
                _('Authentication Failed'),
                msg.reason || _('Twingate could not authenticate you'),
                MessageTray.Urgency.HIGH,
            );
        }
        this._socketClient.sendCommand({ cmd: 'resources' });
    }

    // --- resources ---------------------------------------------------------

    private _updateResources(resources: Twingate.Resource[], user: Twingate.User | null): void {
        this._resources = resources.toSorted((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        );
        this._user = user;
        this._setState(this._state);
        this._renderResources();
    }

    private _matches(): Twingate.Resource[] {
        const query = this._searchEntry.get_text().trim().toLowerCase();
        if (!query) return this._resources;
        return this._resources.filter(
            (r) => r.name.toLowerCase().includes(query) || r.address.toLowerCase().includes(query),
        );
    }

    private _renderResources(): void {
        this._resourcesSection.removeAll();
        const showHidden = this._settings.get_boolean('show-hidden-resources');
        const filtering = this._searchEntry.get_text().trim() !== '';
        const matches = this._matches().filter((r) => showHidden || r.client_visibility !== 2);

        if (matches.length === 0) {
            if (filtering || this._resources.length > 0) {
                this._resourcesSection.addMenuItem(
                    new PopupMenu.PopupMenuItem(_('No matching resources'), { reactive: false }),
                );
                this._resourcesSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            }
            return;
        }

        if (filtering) {
            this._addResourceItems(this._resourcesSection, matches.slice(0, MAX_SEARCH_RESULTS));
            const rest = matches.length - MAX_SEARCH_RESULTS;
            if (rest > 0) {
                this._resourcesSection.addMenuItem(
                    new PopupMenu.PopupMenuItem(
                        ngettext(
                            '%d more, keep typing to narrow down',
                            '%d more, keep typing to narrow down',
                            rest,
                        ).format(rest),
                        { reactive: false },
                    ),
                );
            }
            this._resourcesSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            return;
        }

        const visible = matches.filter((r) => r.client_visibility !== 2);
        const hidden = matches.filter((r) => r.client_visibility === 2);
        const pending = visible.filter((r) => r.auth_state === 'pending');
        const browser = visible.filter((r) => r.auth_state !== 'pending' && r.open_url);
        const other = visible.filter((r) => r.auth_state !== 'pending' && !r.open_url);

        this._addResourceItems(this._resourcesSection, pending);
        this._addResourceItems(this._resourcesSection, browser);
        if (pending.length + browser.length > 0) {
            this._resourcesSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        this._addResourceSubMenu(other, ngettext('%d Resource', '%d Resources', other.length).format(other.length));
        this._addResourceSubMenu(
            hidden,
            ngettext('%d Hidden Resource', '%d Hidden Resources', hidden.length).format(hidden.length),
        );
        this._resourcesSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    private _addResourceSubMenu(resources: Twingate.Resource[], title: string): void {
        if (resources.length === 0) return;
        const item = new PopupMenu.PopupSubMenuMenuItem(title);
        this._addResourceItems(item.menu, resources);
        this._resourcesSection.addMenuItem(item);
    }

    private _addResourceItems(menu: PopupMenu.PopupMenuBase, resources: Twingate.Resource[]): void {
        const showAddress = this._settings.get_boolean('show-addresses');
        for (const resource of resources) {
            const item = new ResourceItem(resource, showAddress);
            item.connect('activate', () => this._activateResource(resource));
            menu.addMenuItem(item);
        }
    }

    private _activateFirstMatch(): void {
        const [first] = this._matches();
        if (!first) return;
        (this.menu as PopupMenu.PopupMenu).close();
        this._activateResource(first);
    }

    private _activateResource(resource: Twingate.Resource): void {
        if (resource.auth_state === 'pending') {
            this._userRequestedAuth = true;
            if (!this._socketClient.sendCommand({ cmd: 'auth', resource: resource.name })) {
                this._userRequestedAuth = false;
            }
            return;
        }
        if (resource.open_url) {
            this._openUri(resource.open_url);
            return;
        }
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, resource.address);
        if (this._settings.get_boolean('copy-notifications')) {
            this._notify(
                _('Address Copied'),
                _('%s copied to clipboard').format(resource.address),
                MessageTray.Urgency.LOW,
            );
        }
    }

    private _openUri(uri: string): void {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, null);
        } catch (e) {
            this._logger.error(`Failed to open ${uri}:`, errorMessage(e));
            this._notify(_('Could Not Open Link'), errorMessage(e), MessageTray.Urgency.HIGH);
        }
    }
}

export default class TwingateExtension extends Extension {
    private _indicator: TwingateIndicator | null = null;
    private _settings: Gio.Settings | null = null;
    private _settingsSignals: number[] = [];

    override enable() {
        this._settings = this.getSettings();
        // Socket path and unit name feed the client and watcher constructors,
        // so a change rebuilds the indicator.
        for (const key of ['socket-path', 'service-name']) {
            this._settingsSignals.push(this._settings.connect(`changed::${key}`, () => this._rebuild()));
        }
        this._createIndicator();
    }

    override disable() {
        for (const id of this._settingsSignals) this._settings?.disconnect(id);
        this._settingsSignals = [];
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }

    private _createIndicator(): void {
        if (!this._settings) return;
        this._indicator = Main.panel.addToStatusArea(
            this.uuid,
            new TwingateIndicator(this.getLogger(), this._settings, `${this.path}/icons`, () => this.openPreferences()),
        );
    }

    private _rebuild(): void {
        this._indicator?.destroy();
        this._indicator = null;
        this._createIndicator();
    }
}
