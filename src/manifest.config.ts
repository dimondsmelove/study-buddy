import { defineManifest } from '@crxjs/vite-plugin'
import { DEFAULT_GATEWAY_URL, gatewayHostPermission } from './shared/gateway-url'

const gatewayHost = gatewayHostPermission(process.env.STUDY_BUDDY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL)

// Study Buddy — Manifest V3.
// Design inherited from OCR Buddy (MIT), stripped of the local-OCR machinery:
//  - Service worker is COORDINATOR ONLY. No DOM, no model, no inference.
//  - The launcher runs on web pages; capture still starts only on user action.
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

  content_scripts: [{ matches: ['http://*/*', 'https://*/*'], js: ['src/content/overlay.ts'] }],
  host_permissions: ['<all_urls>', gatewayHost],

  permissions: [
    'activeTab', // Toolbar/shortcut invocation also works with site access withheld
    'scripting', // Bootstrap already-open tabs and explicit selection fallback
    'storage', // chrome.storage.session (captures) + .local (settings)
    'contextMenus', // Show saved conversations from the toolbar icon's context menu
    'clipboardWrite', // Copy an answer from the extension iframe on explicit user action
  ],

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
