import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

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
    proxy: {
      '/api': 'http://localhost:8080',
      '/yjs': { target: 'ws://localhost:8080', ws: true },
      '/voice': { target: 'ws://localhost:8080', ws: true },
      '/health': 'http://localhost:8080',
    },
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
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          yjs: ['yjs', 'y-indexeddb', '@hocuspocus/provider'],
          // TipTap + ProseMirror only load on doc-mode boards — pull them
          // out of the main chunk so audio/2D/3D/code boards skip the
          // ~250KB parse/eval cost. `@tiptap/extension-collaboration-caret`
          // is the v3 name (was `-cursor` in v2).
          tiptap: [
            '@tiptap/react',
            '@tiptap/starter-kit',
            '@tiptap/extension-collaboration',
            '@tiptap/extension-collaboration-caret',
          ],
          // CodeMirror only loads on code-mode boards — same idea.
          codemirror: [
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/autocomplete',
            '@codemirror/search',
          ],
          // Radix UI primitives — shared across every dialog/dropdown/menu
          // in the app. Splitting them out of the main chunk keeps the
          // initial load leaner (the main bundle no longer ships the entire
          // primitive layer up front; it streams in parallel). Every
          // @radix-ui/* package we depend on is listed here.
          radix: [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-popover',
            '@radix-ui/react-slider',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
            '@radix-ui/react-toast',
            '@radix-ui/react-tooltip',
          ],
          // lucide-react — icon library imported app-wide. Tree-shaking
          // already keeps per-route icon counts low, but the shared runtime
          // (icon base + the handful of icons used on the Home / Header
          // surfaces that everyone hits) is non-trivial; its own chunk
          // means it caches independently of app code.
          icons: ['lucide-react'],
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
