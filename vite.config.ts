import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest.config'
import { DEFAULT_GATEWAY_URL, normalizeGatewayUrl } from './src/shared/gateway-url'

const gatewayUrl = normalizeGatewayUrl(process.env.STUDY_BUDDY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL)

// CRXJS wires up MV3: builds the service worker, the chat page, the content
// overlay, and auto-manages web_accessible_resources / HMR.
export default defineConfig({
  plugins: [crx({ manifest })],
  // The gateway origin is public routing configuration; provider keys stay server-side.
  define: {
    __SB_GATEWAY_URL__: JSON.stringify(gatewayUrl),
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        // The chat window: an extension page embedded as an iframe by the
        // overlay (or opened as a detached popup window by the SW fallback).
        chat: 'src/chat/chat.html',
        // The declared content script also has a stable classic entry for
        // already-open tabs and the explicit activeTab fallback.
        overlay: 'src/content/overlay.ts',
      },
      output: {
        // chrome.scripting.executeScript runs files as CLASSIC scripts: the
        // overlay entry must keep a known path and contain no import statements
        // (its only import is type-only, erased at compile time).
        entryFileNames: (chunk) =>
          chunk.name === 'overlay' ? 'content/overlay.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  server: { port: 5173, strictPort: true },
})
