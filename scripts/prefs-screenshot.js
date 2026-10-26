// Renders the preferences window the way the standalone prefs service does,
// but from the installed directory instead of the running shell's record.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gsk from 'gi://Gsk';
import Graphene from 'gi://Graphene';

Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
const dir = GLib.getenv('EXT_DIR');
const out = GLib.getenv('OUT_PNG');
const metadata = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${dir}/metadata.json`)[1]));

const app = new Adw.Application({ application_id: 'io.github.hanikesn.TwingateStatus.PrefsShot' });
app.connect('activate', () => {
    app.hold();
    run().catch((e) => {
        printerr(`FAILED: ${e.message}\n${e.stack}`);
        app.quit();
    });
});

async function run() {
    const { extensionManager } = await import('resource:///org/gnome/Shell/Extensions/js/extensionsService.js');
    const { ExtensionPrefsDialog } = await import('resource:///org/gnome/Shell/Extensions/js/extensionPrefsDialog.js');
    const serialized = { path: new GLib.Variant('s', dir), type: new GLib.Variant('d', 2), state: new GLib.Variant('d', 1) };
    for (const [k, v] of Object.entries(metadata)) serialized[k] = new GLib.Variant(Array.isArray(v) ? 'as' : typeof v === 'number' ? 'd' : 's', v);
    const extension = extensionManager.createExtensionObject(serialized);
    const dialog = new ExtensionPrefsDialog(extension);
    dialog.application = app;
    dialog.connect('loaded', () => {
        dialog.set_default_size(640, 520);
        dialog.show();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            const w = dialog.get_width(), h = dialog.get_height();
            const snapshot = Gtk.Snapshot.new();
            new Gtk.WidgetPaintable({ widget: dialog }).snapshot(snapshot, w, h);
            const node = snapshot.to_node();
            const renderer = Gsk.Renderer.new_for_surface(dialog.get_surface());
            renderer.realize(dialog.get_surface());
            renderer.render_texture(node, new Graphene.Rect().init(0, 0, w, h)).save_to_png(out);
            renderer.unrealize();
            print(`saved ${out}`);
            app.quit();
            return GLib.SOURCE_REMOVE;
        });
    });
}
app.run([]);
