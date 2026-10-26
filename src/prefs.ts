import '@girs/gjs';
import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import Gtk from '@girs/gtk-4.0';
import { ExtensionPreferences, gettext as _ } from '@girs/gnome-shell/extensions/prefs';

export default class TwingatePreferences extends ExtensionPreferences {
    override fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({ title: _('General'), icon_name: 'network-vpn-symbolic' });
        window.add(page);

        const menuGroup = new Adw.PreferencesGroup({ title: _('Menu') });
        page.add(menuGroup);
        menuGroup.add(
            switchRow(settings, 'show-hidden-resources', _('Show hidden resources'), _('In a collapsed submenu')),
        );
        menuGroup.add(switchRow(settings, 'show-addresses', _('Show addresses'), _('Under each resource name')));
        menuGroup.add(switchRow(settings, 'copy-notifications', _('Notify when an address is copied'), null));
        menuGroup.add(
            switchRow(
                settings,
                'notifier-hint',
                _("Suggest disabling Twingate's own notifier"),
                _('Re-enable it with: systemctl --user unmask twingate-desktop-notifier'),
            ),
        );

        const daemonGroup = new Adw.PreferencesGroup({
            title: _('Twingate Client'),
            description: _('Changing these reconnects the extension'),
        });
        page.add(daemonGroup);
        daemonGroup.add(entryRow(settings, 'socket-path', _('Control socket')));
        daemonGroup.add(entryRow(settings, 'service-name', _('systemd unit')));

        return Promise.resolve();
    }
}

function switchRow(settings: Gio.Settings, key: string, title: string, subtitle: string | null): Adw.SwitchRow {
    const row = new Adw.SwitchRow({ title, subtitle: subtitle ?? '' });
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function entryRow(settings: Gio.Settings, key: string, title: string): Adw.EntryRow {
    const row = new Adw.EntryRow({ title, show_apply_button: true });
    row.set_text(settings.get_string(key));
    row.connect('apply', () => {
        const value = row.get_text().trim();
        if (value) settings.set_string(key, value);
        else row.set_text(settings.get_string(key));
    });

    const reset = new Gtk.Button({ icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, has_frame: false });
    reset.set_tooltip_text(_('Reset to default'));
    reset.connect('clicked', () => {
        settings.reset(key);
        row.set_text(settings.get_string(key));
    });
    row.add_suffix(reset);
    return row;
}
