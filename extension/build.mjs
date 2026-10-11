import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dir = (path) => fileURLToPath(new URL(path, import.meta.url));
const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');

// Small fixes to @duckduckgo/autoconsent applied at bundle time. Each one must match exactly,
// so an upgrade that changes the code fails the build instead of silently dropping the fix.
const autoconsentPatches = [
    {
        // The heuristic collects buttons with `[class*="button"]` and keeps only the innermost
        // matches, so an <svg class="…button-icon"> inside a <button> replaces the button itself
        // and, having no innerText, is then dropped (adidas.nl loses its "reject" button).
        find: 'excludeContainers(getButtonLikeElements(el))',
        replace: 'excludeContainers(getButtonLikeElements(el).filter((b) => b instanceof HTMLElement))',
    },
];

const patchAutoconsent = {
    name: 'patch-autoconsent',
    setup(build) {
        build.onLoad({ filter: /@duckduckgo[\\/]autoconsent[\\/]dist[\\/]autoconsent\.esm\.js$/ }, async (args) => {
            let contents = await readFile(args.path, 'utf8');
            for (const { find, replace } of autoconsentPatches) {
                if (!contents.includes(find)) {
                    throw new Error(`autoconsent patch no longer applies: ${find}`);
                }
                contents = contents.replace(find, replace);
            }
            return { contents, loader: 'js' };
        });
    },
};

const common = {
    bundle: true,
    target: 'safari17',
    absWorkingDir: dir('.'),
    loader: { '.css': 'text' },
    plugins: [patchAutoconsent],
    logLevel: 'info',
};

if (dev) {
    // Playgrounds: http://localhost:8123/toast.html, http://localhost:8123/popup.html
    const toast = await esbuild.context({ ...common, entryPoints: ['dev/harness.js'], outdir: 'dev/build', format: 'iife' });
    const popup = await esbuild.context({
        ...common,
        entryPoints: ['src/popup/popup.js', 'src/popup/popup.css'],
        outdir: 'dev/build/popup',
        format: 'iife',
        loader: { '.css': 'css' },
    });
    await popup.watch();
    await toast.watch();
    await toast.serve({ servedir: dir('dev'), port: 8123 });
} else {
    const outdir = dir('../Shared (Extension)/Resources/');
    const contexts = await Promise.all([
        esbuild.context({ ...common, outdir, entryPoints: ['src/content.js'], format: 'iife' }),
        esbuild.context({ ...common, outdir, entryPoints: ['src/background.js'], format: 'esm' }),
        esbuild.context({ ...common, outdir, entryPoints: ['src/popup/popup.js'], format: 'esm' }),
        esbuild.context({ ...common, outdir, entryPoints: ['src/popup/popup.css'], loader: { '.css': 'css' } }),
    ]);
    if (watch) {
        await Promise.all(contexts.map((ctx) => ctx.watch()));
    } else {
        await Promise.all(contexts.map((ctx) => ctx.rebuild()));
        await Promise.all(contexts.map((ctx) => ctx.dispose()));
    }
}
