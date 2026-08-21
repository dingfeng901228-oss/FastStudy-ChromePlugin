import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { cpSync } from 'node:fs';
import pkg from './package.json';

/**
 * Copies `src/_locales/` into `dist/_locales/` on build.
 * Same pattern as upstream — @crxjs/vite-plugin@2.7.1 doesn't copy
 * _locales/ automatically; Chrome rejects loading the extension
 * with "Default locale was specified, but _locales subtree is missing".
 */
function copyLocalesPlugin() {
  return {
    name: 'copy-locales',
    apply: 'build' as const,
    closeBundle() {
      cpSync('src/_locales', 'dist/_locales', { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    copyLocalesPlugin(),
    crx({
      manifest: {
        manifest_version: 3,
        name: pkg.displayName ?? pkg.name,
        version: pkg.version,
        description: pkg.description,
        // MVP: no content_scripts. V3 (需求三十三) will add a content
        // script for the hover-popover UI. For now, all logic lives in
        // the service worker (contextMenus) and popup.
        background: {
          service_worker: 'src/background/background.ts',
          type: 'module',
        },
        permissions: [
          'contextMenus', // right-click "收藏为生词" menu
          'storage',       // chrome.storage.local for token + pendingVocabulary queue
          'alarms',        // background sync wake-up (offline queue retry)
        ],
        // Only talk to jp.frank2025.com — minimal permission per 需求 §6/§24.
        // No <all_urls>, no tabs, no cookies, no webRequest.
        host_permissions: ['https://jp.frank2025.com/*'],
        // chrome.i18n: default_locale requires _locales/<locale>/messages.json
        // at the extension root. src/_locales/en/messages.json is copied to
        // dist/_locales/en/messages.json by copyLocalesPlugin above.
        default_locale: 'en',
        icons: {
          '16': 'icons/icon-16.png',
          '32': 'icons/icon-32.png',
          '48': 'icons/icon-48.png',
          '128': 'icons/icon-128.png',
        },
        action: {
          default_popup: 'src/popup/popup.html',
          default_title: pkg.displayName ?? pkg.name,
          default_icon: {
            '16': 'icons/icon-16.png',
            '32': 'icons/icon-32.png',
            '48': 'icons/icon-48.png',
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5174 },
  },
  build: {
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        popup: 'src/popup/popup.html',
      },
    },
  },
});