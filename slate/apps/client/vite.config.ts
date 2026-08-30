import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Vendor chunk groups, in priority order — the FIRST group whose package owns
 * a module wins. Shared runtime libraries come first so a feature bundle can't
 * swallow them; everything below is split so a board only downloads the editor
 * it actually opened.
 */
/**
 * Vendor chunk groups, in priority order — the FIRST group whose package
 * matches wins. An entry ending in `/` or `-` is treated as a prefix.
 *
 * Two rules here were learned the hard way:
 *
 *   1. Shared runtime libraries must be listed BEFORE the feature bundles that
 *      would otherwise absorb them. React was unlisted, fell through to
 *      Rollup's automatic chunking, and landed inside `three` — so every chunk
 *      in the app imported the 1.2MB three bundle just to reach React, and the
 *      entry preloaded it on a 2D board.
 *
 *   2. Cyclically-coupled packages must stay in ONE chunk. `three` and
 *      `three-stdlib` import each other; splitting them per-package produced
 *      "Cannot access 'Ot' before initialization" and took out the entire 3D
 *      editor at runtime. Groups are drawn around ecosystems for that reason,
 *      not around individual packages.
 */
const CHUNK_GROUPS: [string, string[]][] = [
  ['react', ['react', 'react-dom', 'scheduler']],
  // use-sync-external-store is zustand's React shim, so it belongs here. Left
  // unlisted it landed inside `tiptap`, and because every store in the app
  // needs it the entry side-effect-imported that 500KB chunk on every board.
  ['state', ['zustand', 'use-sync-external-store', 'fast-equals']],
  ['three', ['three', 'three-stdlib', '@react-three/']],
  ['yjs', ['yjs', 'y-indexeddb', 'y-protocols', 'lib0', '@hocuspocus/']],
  // TipTap + ProseMirror only load on doc-mode boards.
  ['tiptap', ['@tiptap/', 'prosemirror-', 'y-prosemirror']],
  // CodeMirror + Lezer only load on code-mode boards.
  ['codemirror', ['@codemirror/', '@lezer/', 'y-codemirror.next']],
  // Radix primitives back every dialog / dropdown / menu; shared, so they
  // cache independently of app code.
  ['radix', ['@radix-ui/']],
  ['icons', ['lucide-react']],
];


/** npm package name for a node_modules module id, or null. Handles scoped
 *  names and pnpm's nested .pnpm/<pkg>@<ver>/node_modules/<pkg>/ layout, where
 *  the LAST node_modules segment names the real package. Rollup normalises ids
 *  to POSIX separators on every platform, so no separator juggling here.
 *  Returns the RAW name (scope included) — CHUNK_GROUPS matches on it. */
function packageOf(id: string): string | null {
  const at = id.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const rest = id.slice(at + '/node_modules/'.length).split('/');
  const name = rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return name ?? null;
}

/** Dev + preview both talk to a sync server on :8080 (the port the Fastify
 *  server defaults to), so a locally running stack is reachable at the same
 *  origin the production deployment serves everything from. */
const devProxy = {
  '/api': 'http://localhost:8080',
  '/yjs': { target: 'ws://localhost:8080', ws: true },
  '/voice': { target: 'ws://localhost:8080', ws: true },
  '/health': 'http://localhost:8080',
};

export default defineConfig({
  define: {
    // Build stamp shown in Settings → About. The PWA service worker can keep
    // serving a cached bundle for a while after a deploy — this makes "which
    // version is this browser actually running?" answerable at a glance.
    __SLATE_BUILD__: JSON.stringify(
      `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    ),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: devProxy,
  },
  // `vite preview` is what the e2e suite runs against, and without the same
  // proxy the built bundle has no server: /health answers with the SPA's HTML,
  // the client decides it is on static hosting and goes local-only, and every
  // collaboration test silently degrades into a single-user one.
  preview: {
    port: 4173,
    proxy: devProxy,
  },
  build: {
    target: 'es2022',
    // No production source maps: they roughly double rollup's memory use
    // (which can OOM free-tier CI builders), add ~9MB to the artifact, and
    // publish the readable source. Set to true locally when debugging a
    // production-only issue.
    sourcemap: false,
    // The main entry pulls in React + the shared Radix UI primitive layer +
    // lucide-react icons (used app-wide), and those split chunks together
    // land near the warning threshold. We split them deliberately (below);
    // bump the limit so a clean production build doesn't print a noisy
    // "chunk size exceeds 500 kB" warning for chunks we intentionally sized.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vite's own dynamic-import preload helper. Rollup puts shared code
          // in whichever chunk claims it first, and this landed inside
          // `three` — so the ENTRY chunk statically imported 868KB of three.js
          // purely to reach a ~1KB helper, on every board including 2D and
          // doc. Pinning it here keeps the entry's static graph honest.
          if (id.includes('vite/preload-helper') || id.includes('vite/modulepreload-polyfill')) {
            return 'vite-helpers';
          }
          const pkg = packageOf(id);
          if (!pkg) return undefined;
          // First match wins; see CHUNK_GROUPS for why order matters.
          for (const [chunk, patterns] of CHUNK_GROUPS) {
            const hit = patterns.some((p) =>
              p.endsWith('/') || p.endsWith('-') ? pkg.startsWith(p) : pkg === p,
            );
            if (hit) return chunk;
          }
          // Everything else falls to Rollup automatic chunking. Splitting the
          // long tail per-package is tempting but unsafe: unrelated vendors
          // can be cyclically coupled, and separate chunks break their
          // initialization order.
          return undefined;
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'icon.svg'],
      manifest: {
        name: 'Slate',
        short_name: 'Slate',
        description: 'Real-time collaborative 2D whiteboard and Blender-style 3D editor.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'any',
        background_color: '#0c0c0e',
        theme_color: '#0c0c0e',
        categories: ['productivity', 'graphics', 'education'],
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
          { src: '/icon.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/yjs/') || url.pathname.startsWith('/voice'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /\.(?:js|css|html|svg|woff2?)$/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'slate-assets-v1' },
          },
        ],
        globPatterns: ['**/*.{js,css,html,svg,ico,webmanifest}'],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**', '**/tests/e2e/**'],
  },
});
