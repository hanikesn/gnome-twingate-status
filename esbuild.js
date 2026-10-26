import { build } from 'esbuild';
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const root = dirname(fileURLToPath(import.meta.url));
const metadata = JSON.parse(await fs.readFile(resolve(root, 'src/metadata.json'), 'utf8'));

console.log(`Building ${metadata.name} ${metadata['version-name']}...`);

const common = {
    bundle: true,
    // Keep enable()/disable() even though nothing in the bundle references them.
    treeShaking: false,
    // firefox128: SpiderMonkey 128, the engine of GJS 1.84+ (GNOME 48+).
    target: 'firefox128',
    platform: 'neutral',
    format: 'esm',
    external: ['gi://*', 'resource://*', 'system', 'gettext', 'cairo'],
};

await build({ ...common, entryPoints: ['src/extension.ts', 'src/prefs.ts'], outdir: 'dist' });
// Test harnesses are plain GJS scripts and must not ship in the extension zip.
await build({ ...common, entryPoints: ['src/test/live.ts', 'src/test/client.test.ts'], outdir: 'dist-test/test' });

await fs.copyFile(resolve(root, 'src/metadata.json'), resolve(root, 'dist/metadata.json'));
await fs.copyFile(resolve(root, 'src/stylesheet.css'), resolve(root, 'dist/stylesheet.css'));
await fs.cp(resolve(root, 'src/icons'), resolve(root, 'dist/icons'), { recursive: true });
await fs.cp(resolve(root, 'src/schemas'), resolve(root, 'dist/schemas'), { recursive: true });
// Validate only; extensions.gnome.org compiles schemas itself and rejects a
// shipped gschemas.compiled, and `gnome-extensions install` compiles locally.
execFileSync('glib-compile-schemas', ['--strict', '--dry-run', resolve(root, 'dist/schemas')], { stdio: 'inherit' });

const zipFilename = `${metadata.uuid}.zip`;
const zip = new AdmZip();
zip.addLocalFolder(resolve(root, 'dist'));
await zip.writeZipPromise(resolve(root, zipFilename));

console.log(`Build complete: ${zipFilename}`);
console.log(`Install with:  gnome-extensions install --force ${zipFilename}`);
console.log(`Enable with:   gnome-extensions enable ${metadata.uuid}`);
console.log('On Wayland, log out and back in for the shell to pick up a new version.');
