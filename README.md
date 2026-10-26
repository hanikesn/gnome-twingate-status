# Twingate Status GNOME Extension

A GNOME Shell extension that shows the Twingate VPN connection state in the top
bar, lists accessible resources, and surfaces authentication requests as
notifications.

## Features

- Panel icon reflecting the service and tunnel state
- Connect / Disconnect menu entry that starts or stops `twingate.service`
  (polkit prompts for authorization when needed)
- Signed-in user and resource list in the menu
    - resources with a browser URL open directly
    - other resources copy their address to the clipboard
    - hidden resources live in a collapsed submenu
- Notification with an **Authenticate** action when Twingate asks for re-auth
- Settings entry in the menu
- One-time prompt when Twingate's own `twingate-desktop-notifier` user service
  is running, since both show the same sign-in prompts. "Disable Notifier"
  masks and stops it; undo with `systemctl --user unmask twingate-desktop-notifier`

## Requirements

- GNOME Shell 49 or 50
- Twingate Linux client providing the `SOCK_SEQPACKET` socket at
  `/run/twingate/auth.sock` and running as `twingate.service`

## Installation

Download or build `twingate-status@hanikesn.github.io.zip`, then:

```bash
gnome-extensions install --force twingate-status@hanikesn.github.io.zip
gnome-extensions enable twingate-status@hanikesn.github.io
```

The shell only loads a new version of an extension at session start. On
Wayland, log out and back in; on X11 you can also press `Alt+F2`, type `r`,
and press Enter.

## Development

```bash
pnpm install
pnpm run validate   # tsc, oxlint (type-aware) and oxfmt --check
pnpm run lint:fix   # apply lint autofixes
pnpm run format     # format sources with oxfmt
pnpm run build      # bundle to dist/, compile the schema, create the zip
pnpm run dist       # build and install into ~/.local/share/gnome-shell/extensions
pnpm test           # socket client tests against an in-process fake daemon
pnpm run test:live  # socket and systemd check against the real daemon
pnpm run screenshot # capture the menu in a headless shell into screenshots/
pnpm run review     # run the Shexli extensions.gnome.org review checks on the zip
```

Settings live in the GSettings schema under `src/schemas`. The zip ships only
the XML; `gnome-extensions install` and extensions.gnome.org compile it. Open the preferences with
`gnome-extensions prefs twingate-status@hanikesn.github.io`.

The build bundles the TypeScript sources with esbuild. GI and shell modules
stay external imports (`gi://…`, `resource://…`) so the bundle runs inside
GNOME Shell unchanged. `St` is imported without a version so the same bundle
works on every shell version listed in `metadata.json`.

### Trying it in a nested shell

`pnpm run shell` starts a nested GNOME Shell. It reads the same dconf
settings as the live session, so enabling the extension there enables it for
the real session as well. `scripts/screenshot.sh` shows the safe pattern: a
headless shell under its own `DCONF_PROFILE` whose `user-db` is deleted
afterwards, with the menu driven over D-Bus `Eval` in unsafe mode.

Shell logs:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Protocol

Every packet on the socket is one JSON document.

Daemon to client:

| `cmd`           | Meaning                                                      |
| --------------- | ------------------------------------------------------------ |
| `status`        | `msg` is `Online`, `Offline` or `Authenticating`             |
| `status-end`    | Trailer after the initial status burst                       |
| `resources`     | Header with `content-length`; the next packet is the payload |
| `reauth`        | Re-authentication needed, `url` opens the sign-in page       |
| `auth-required` | A resource needs authentication                              |
| `auth-end`      | Authentication flow finished, `state` is the result          |

The resources payload has no `cmd` and carries `user`, `admin_url` and the
`resources` array. See `examples/resources.json`.

Client to daemon:

```json
{ "cmd": "resources" }
```

## License

MIT
