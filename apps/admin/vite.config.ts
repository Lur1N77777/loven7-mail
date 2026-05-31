import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const projectRoot = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
  return {
    root: projectRoot,
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'Loven7-Mail Admin',
          short_name: 'Loven7-Mail',
          description: 'Cloudflare Temp Email 管理员 PWA 前端',
          theme_color: '#f7f7f8',
          background_color: '#f7f7f8',
          display: 'standalone',
          start_url: '/',
          icons: [
            { src: '/pwa.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
          ]
        },
        workbox: {
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/\?.*\bJWT=/i, /\/api\//, /\/admin\//, /\/open_api\//],
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
          runtimeCaching: [
            {
              urlPattern: ({ request, url }) => request.destination === 'document' && !/\bJWT=/i.test(url.search),
              handler: 'NetworkFirst',
              options: { cacheName: 'loven7-pages', expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 } }
            }
          ]
        }
      })
    ],
    define: {
      __APP_VERSION__: JSON.stringify(env.npm_package_version || '0.1.0')
    },
    resolve: {
      alias: { '@': path.resolve(projectRoot, 'src') }
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true'
    },
    build: {
      target: 'es2020',
      sourcemap: false,
      cssCodeSplit: true,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('postal-mime')) return 'postal-mime';
            if (id.includes('lucide-react')) return 'icons';
            if (id.includes('react-dom')) return 'react-dom';
            if (id.includes('/react/') || id.endsWith('/react/index.js') || id.includes('scheduler')) return 'react';
            return 'vendor';
          },
        },
      },
    },
  };
});
