#!/bin/bash
# Captures the extension menu in a headless GNOME Shell, plus the preferences
# window, and writes PNGs to screenshots/. With FAKE_DAEMON=1 the shell talks
# to scripts/fake-daemon.js serving examples/resources.json instead of the
# real client, and screenshots/ego.png is cropped for extensions.gnome.org. The shell runs under its own dconf profile so the live
# session's settings are untouched, and in unsafe mode so the menu can be
# opened over D-Bus Eval.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' "$ROOT/src/metadata.json")
OUT="$ROOT/screenshots"
WORK=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/tg-shot-XXXXXX")
trap 'rm -rf "$WORK" "$HOME/.config/dconf/tgscreenshot"' EXIT
mkdir -p "$OUT"

cat > "$WORK/dconf-profile" <<PROFILE
user-db:tgscreenshot
system-db:local
system-db:site
system-db:distro
PROFILE

FAKE_SOCKET="$WORK/auth.sock"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

cat > "$WORK/inner.sh" <<INNER
#!/bin/bash
export MUTTER_DEBUG_DUMMY_MODE_SPECS=1280x720
unset WAYLAND_DISPLAY DISPLAY
if [ "\${FAKE_DAEMON:-0}" = 1 ]; then
    gjs -m "$ROOT/scripts/fake-daemon.js" "$FAKE_SOCKET" "$ROOT/examples/resources.json" &
    GSETTINGS_SCHEMA_DIR="$EXT_DIR/schemas" gsettings set org.gnome.shell.extensions.twingate-status socket-path "$FAKE_SOCKET"
fi
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$UUID']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '99'
gnome-shell --headless --unsafe-mode --virtual-monitor 1280x720 --wayland-display=wayland-tg-\$\$ > "$WORK/shell.log" 2>&1 &
PID=\$!
sleep 14
# Theme icons are loaded the first time an item is mapped, a few seconds
# later. Open everything once as a warm-up before the real captures.
for shot in warmup menu submenu search; do
    JS=\$(sed -e "s|@UUID@|$UUID|" -e "s|@OUT@|$OUT/\$shot.png|" -e "s|@SHOT@|\$shot|" "$ROOT/scripts/screenshot.js")
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "\$JS" > /dev/null
    sleep 5
done
rm -f "$OUT/warmup.png"
kill -KILL \$PID
[ "\${FAKE_DAEMON:-0}" = 1 ] && kill %1
INNER
chmod +x "$WORK/inner.sh"

DCONF_PROFILE="$WORK/dconf-profile" timeout -s KILL 90 dbus-run-session -- "$WORK/inner.sh" || true

if grep -q "JS ERROR" "$WORK/shell.log"; then
    echo "JS errors in the shell log:" >&2
    grep -A3 "JS ERROR" "$WORK/shell.log" >&2
fi
# The preferences window is rendered by a plain GJS process using the
# shell's own prefs dialog class, so it needs the shell's private typelibs.
GI_TYPELIB_PATH=/usr/lib64/gnome-shell/girepository-1.0 LD_LIBRARY_PATH=/usr/lib64/gnome-shell \
    EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID" OUT_PNG="$OUT/prefs.png" \
    timeout 30 gjs -m "$ROOT/scripts/prefs-screenshot.js" 2>&1 | grep -E "saved|FAILED" || true

if [ "${FAKE_DAEMON:-0}" = 1 ] && command -v magick >/dev/null; then
    # Menu plus a little top bar context, the shape the listing page shows.
    magick "$OUT/menu.png" -crop 420x560+880+0 +repage "$OUT/ego.png"
fi

ls -1 "$OUT"/*.png
