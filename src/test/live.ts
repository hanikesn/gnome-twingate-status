// Manual integration check against the real daemon: `pnpm run test:live`.
// Connects to the socket, requests resources, watches the unit, and exits.
import GLib from '@girs/glib-2.0';
import { TwingateSocketClient } from '../TwingateSocketClient.js';
import { SystemdService } from '../SystemdService.js';

const loop = new GLib.MainLoop(null, false);
let exitCode = 1;

const client = new TwingateSocketClient(console, {
    onConnected: () => {
        console.log('socket: connected');
        client.sendCommand({ cmd: 'resources' });
    },
    onDisconnected: () => console.log('socket: disconnected'),
    onError: (e) => console.error('socket:', e),
    onMessage: (message) => {
        if ('cmd' in message) {
            console.log('message:', message.cmd);
            return;
        }
        console.log(`resources: ${message.resources.length} (user ${message.user?.email ?? 'none'})`);
        exitCode = 0;
        loop.quit();
    },
});

const service = new SystemdService('twingate.service', console, {
    onActive: () => {
        console.log('unit: active');
        client.serviceActive();
    },
    onInactive: () => {
        console.log('unit: inactive (start it and rerun)');
        loop.quit();
    },
    onFailed: () => {
        console.log('unit: failed');
        loop.quit();
    },
});

service.startWatching().catch((e) => {
    console.error('watch failed:', e);
    loop.quit();
});

GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
    console.error('timeout waiting for resources');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

await loop.runAsync();
service.stopWatching();
client.destroy();
imports.system.exit(exitCode);
