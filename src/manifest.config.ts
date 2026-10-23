import { defineManifest } from '@crxjs/vite-plugin'
import { DEFAULT_GATEWAY_URL, gatewayHostPermission } from './shared/gateway-url'
import { DEFAULT_WELCOME_URL, welcomeOriginMatch } from './shared/welcome-url'

const gatewayHost = gatewayHostPermission(process.env.STUDY_BUDDY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL)
const welcomeMatch = welcomeOriginMatch(process.env.STUDY_BUDDY_WELCOME_URL ?? DEFAULT_WELCOME_URL)

// Study Buddy — Manifest V3.
// Design inherited from OCR Buddy (MIT), stripped of the local-OCR machinery:
//  - Service worker is COORDINATOR ONLY. No DOM, no model, no inference.
//  - The launcher runs on web pages; capture still starts only on user action.
//  - No side panel: the chat window is an extension-page iframe embedded in the
//    page near the selection (see src/content/overlay.ts).
export default defineManifest({
  manifest_version: 3,
  // Chat layout uses :has() (Chrome 105+); chrome.storage.session needs 102+.
  minimum_chrome_version: '105',
  incognito: 'not_allowed',
  default_locale: 'en',
  name: '__MSG_appName__',
  version: '0.1.0',
  description: '__MSG_shortDesc__',
  action: {
    default_title: 'Study Buddy — select a region (Ctrl+Shift+Y)',
    default_icon: {
      '16': 'icons/icon16.png',
      '32': 'icons/icon32.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png',
    },
  },

  externally_connectable: { matches: [welcomeMatch] },

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
