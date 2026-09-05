import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/crumbs/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Crumbs',
        short_name: 'Crumbs',
        description: 'Holder snapshots, airdrops and token account cleanup on Cookie Chain.',
        theme_color: '#12100c',
        background_color: '#12100c',
        display: 'standalone',
        start_url: '/crumbs/',
        scope: '/crumbs/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/crumbs/index.html',
        runtimeCaching: [
          {
            // token registry: fast from cache, refreshed in the background
            urlPattern: ({ url }) => url.origin === 'https://cookiescan.io' && url.pathname === '/api/tokens',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'token-registry', expiration: { maxEntries: 1, maxAgeSeconds: 60 * 60 } },
          },
          {
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'CacheFirst',
            options: { cacheName: 'logos', expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 } },
          },
        ],
      },
    }),
  ],
  build: { target: 'es2022' },
})
