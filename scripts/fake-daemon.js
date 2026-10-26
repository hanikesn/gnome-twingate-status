#!/usr/bin/gjs -m
// Serves examples/resources.json over a SOCK_SEQPACKET socket the way the
// Twingate daemon does. Usage: fake-daemon.js <socket path> <resources.json>
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const [socketPath, resourcesFile] = ARGV;
const payload = new TextDecoder().decode(GLib.file_get_contents(resourcesFile)[1]).trim();
const encoder = new TextEncoder();

GLib.unlink(socketPath);
const socket = Gio.Socket.new(Gio.SocketFamily.UNIX, Gio.SocketType.SEQPACKET, Gio.SocketProtocol.DEFAULT);
socket.bind(Gio.UnixSocketAddress.new(socketPath), true);
socket.listen();
const listener = new Gio.SocketListener();
listener.add_socket(socket, null);

function send(conn, packet) {
    conn.get_output_stream().write_bytes(encoder.encode(typeof packet === 'string' ? packet : JSON.stringify(packet)), null);
}

function serve(conn) {
    send(conn, { cmd: 'status', details: 'User', internet_security: 0, msg: 'Online' });
    send(conn, { cmd: 'status-end' });
    const input = conn.get_input_stream();
    const read = () =>
        input.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, null, (stream, result) => {
            let data;
            try {
                data = stream.read_bytes_finish(result).toArray();
            } catch {
                return;
            }
            if (data.length === 0) return;
            const cmd = JSON.parse(new TextDecoder().decode(data));
            if (cmd.cmd === 'resources') {
                send(conn, { cmd: 'resources', 'content-length': payload.length });
                send(conn, payload);
            }
            read();
        });
    read();
}

function accept() {
    listener.accept_async(null, (l, result) => {
        const [conn] = l.accept_finish(result);
        serve(conn);
        accept();
    });
}
accept();
print(`fake daemon listening on ${socketPath}`);
new GLib.MainLoop(null, false).run();
