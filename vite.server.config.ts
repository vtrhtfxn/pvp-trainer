import { defineConfig } from 'vite';

// Bundles the whole multiplayer server — duel simulation, WebSocket implementation and all —
// into one dependency-free dist-server/server.mjs, so a friend on Windows only needs Node.
export default defineConfig({
  build: {
    ssr: 'src/server/main.ts',
    outDir: 'dist-server',
    target: 'node20',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: { format: 'es', entryFileNames: 'server.mjs' },
    },
  },
});
