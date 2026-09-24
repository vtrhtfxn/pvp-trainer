// Packages the built game into "PvP Trainer.app" (dist-app/). Host architecture by default;
// pass --universal for a universal binary, or --arch=x64 / --arch=arm64.

import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing — run "npm run build" first.');
  process.exit(1);
}

const archArg = process.argv.find((a) => a.startsWith('--arch='));
const arch = process.argv.includes('--universal') ? 'universal' : (archArg?.slice(7) ?? process.arch);

const paths = await packager({
  dir: ROOT,
  out: path.join(ROOT, 'dist-app'),
  name: 'PvP Trainer',
  appBundleId: 'dev.pvptrainer.app',
  appCategoryType: 'public.app-category.games',
  platform: 'darwin',
  arch,
  icon: path.join(ROOT, 'electron', 'icon.icns'),
  overwrite: true,
  // Nothing in node_modules ships — three.js and the fonts are already inlined into dist.
  prune: false,
  // Only the app shell and the single-file build ship; nothing else is needed at runtime.
  ignore: [
    /^\/src($|\/)/,
    /^\/tests($|\/)/,
    /^\/node_modules($|\/)/,
    /^\/dist-app($|\/)/,
    /^\/\.(git|claude|DS_Store)/,
    /^\/New Folder With Items($|\/)/,
    /^\/[^/]+\.glb$/,
    /^\/(index\.html|vite\.config\.ts|tsconfig\.json|package-lock\.json|README\.md)$/,
    /^\/electron\/(make-icon|build-app)\.mjs$/,
  ],
  extendInfo: {
    NSHumanReadableCopyright: 'Not affiliated with Mojang or Microsoft.',
    LSMinimumSystemVersion: '11.0',
  },
});

for (const p of paths) console.log(`app → ${path.relative(process.cwd(), p)}`);
