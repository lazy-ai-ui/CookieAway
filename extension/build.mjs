import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const outdir = fileURLToPath(new URL('../Shared (Extension)/Resources/', import.meta.url));
const watch = process.argv.includes('--watch');

const common = {
    bundle: true,
    target: 'safari17',
    outdir,
    logLevel: 'info',
};

const contexts = await Promise.all([
    esbuild.context({ ...common, entryPoints: ['src/content.js'], format: 'iife' }),
    esbuild.context({ ...common, entryPoints: ['src/background.js'], format: 'esm' }),
]);

if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
