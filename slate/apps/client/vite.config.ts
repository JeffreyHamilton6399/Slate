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
