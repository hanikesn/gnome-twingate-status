// Evaluated inside gnome-shell by scripts/screenshot.sh via org.gnome.Shell.Eval.
const Gio = imports.gi.Gio;
const Shell = imports.gi.Shell;
const shot = '@SHOT@';
const indicator = Main.panel.statusArea['@UUID@'];
indicator.menu.close(false);
indicator._searchEntry.set_text(shot === 'search' ? 'prod' : '');
indicator.menu.open(false);
if (shot === 'submenu' || shot === 'warmup') {
    for (const item of indicator._resourcesSection._getMenuItems()) {
        if (item.menu && item.menu.open) item.menu.open(false);
    }
}
const screenshot = new Shell.Screenshot();
const stream = Gio.File.new_for_path('@OUT@').replace(null, false, 0, null);
screenshot.screenshot(false, stream, null, (_o, res) => {
    screenshot.screenshot_finish(res);
    stream.close(null);
});
'ok';
