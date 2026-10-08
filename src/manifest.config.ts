import { defineManifest } from '@crxjs/vite-plugin'

// Study Buddy — Manifest V3.
// Design inherited from OCR Buddy (MIT), stripped of the local-OCR machinery:
//  - Service worker is COORDINATOR ONLY. No DOM, no model, no inference.
//  - `activeTab` (not <all_urls>) — the overlay is injected only on user action,
//    so there is no "read and change all your data" install warning.
//  - No side panel: the chat window is an extension-page iframe embedded in the
//    page near the selection (see src/content/overlay.ts).
export default defineManifest({
  manifest_version: 3,
  incognito: 'not_allowed',
  name: 'Study Buddy',
  version: '0.1.0',
  description:
    'Select any region of the screen and ask an AI about it — solve, explain, translate.',
  action: {
    default_title: 'Study Buddy — select a region (Ctrl+Shift+Y)',
    default_icon: { '16': 'icons/icon16.png', '32': 'icons/icon32.png' },
  },

  commands: {
    'start-capture': {
      // Ctrl+Shift+O is reserved by Chrome (Bookmark Manager); Y is free.
      suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
      description: 'Study Buddy: select a region',
    },
  },

  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },

  // No declared content script: a `matches: <all_urls>` declaration triggers the
  // "read and change all your data on all websites" install warning. The overlay
  // is injected on demand by the service worker (chrome.scripting + activeTab /
  // granted host), built as a fixed-name classic script entry in vite.config.ts.
  permissions: [
    'activeTab', // captureVisibleTab on the tab where invoked
    'scripting', // inject the selection overlay on demand
    'storage', // chrome.storage.session (captures) + .local (settings)
  ],

  // Not requested at install. Asked at runtime, per-site, when a capture needs
  // a tab the user didn't invoke on. The screenshot stays gated per origin.
  optional_host_permissions: ['<all_urls>'],

  web_accessible_resources: [
    {
      // The chat window is embedded in pages as an iframe from this URL.
      resources: ['src/chat/chat.html', 'icons/icon32.png'],
      matches: ['<all_urls>'],
    },
  ],

  icons: {
    '16': 'icons/icon16.png',
    '32': 'icons/icon32.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png',
  },
})
