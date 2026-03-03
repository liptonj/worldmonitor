/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { clientsClaim, skipWaiting } from 'workbox-core';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, NetworkOnly, CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

declare const self: ServiceWorkerGlobalScope;

skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

// Injected by vite-plugin-pwa
precacheAndRoute(self.__WB_MANIFEST);

// Navigation: network-first, 3s timeout
registerRoute(
  ({ request }) => request.mode === 'navigate',
  new NetworkFirst({
    cacheName: 'html-navigation',
    networkTimeoutSeconds: 3,
  }),
);

// API routes: network-only
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && /^\/api\//.test(url.pathname),
  new NetworkOnly(),
  'GET',
);
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && /^\/api\//.test(url.pathname),
  new NetworkOnly(),
  'POST',
);
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && /^\/rss\//.test(url.pathname),
  new NetworkOnly(),
  'GET',
);

// MapTiler tiles
registerRoute(
  ({ url }) => /^https:\/\/api\.maptiler\.com\//.test(url.href),
  new CacheFirst({
    cacheName: 'map-tiles',
    plugins: [
      new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// Carto tiles
registerRoute(
  ({ url }) => /^https:\/\/[abc]\.basemaps\.cartocdn\.com\//.test(url.href),
  new CacheFirst({
    cacheName: 'carto-tiles',
    plugins: [
      new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// Google Fonts CSS
registerRoute(
  ({ url }) => /^https:\/\/fonts\.googleapis\.com\//.test(url.href),
  new StaleWhileRevalidate({
    cacheName: 'google-fonts-css',
    plugins: [new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 365 * 24 * 60 * 60 })],
  }),
);

// Google Fonts woff2
registerRoute(
  ({ url }) => /^https:\/\/fonts\.gstatic\.com\//.test(url.href),
  new CacheFirst({
    cacheName: 'google-fonts-woff',
    plugins: [
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// Locale files
registerRoute(
  ({ url }) => /\/assets\/locale-.*\.js$/i.test(url.pathname),
  new CacheFirst({
    cacheName: 'locale-files',
    plugins: [
      new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 30 * 24 * 60 * 60 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
);

// Images
registerRoute(
  ({ url }) => /\.(?:png|jpg|jpeg|svg|gif|webp)$/i.test(url.pathname),
  new StaleWhileRevalidate({
    cacheName: 'images',
    plugins: [new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 7 * 24 * 60 * 60 })],
  }),
);
