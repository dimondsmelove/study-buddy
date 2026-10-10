# Study Buddy — Privacy Policy

_Last updated: 2026-10-10 · draft; not a release/compliance certification_

Study Buddy is a browser extension that lets you select a region of a web page
and ask an AI model about it. This policy explains exactly what leaves your
device and what does not. Selected images and typed text can contain personal
information; do not send material you are not authorized to share with your
chosen provider.

## Summary

- We run **no servers** and have **no accounts**.
- There is **no analytics or telemetry** in this client.
- This local acceptance build has no built-in key. The private development
  launcher supplies a provider connection stored locally on the device; users
  are not asked to enter a key in the ordinary interface.
- Selected images, typed questions/attempts, generated instructions and bounded
  prior conversation text go **directly to your chosen AI endpoint**. Nothing
  passes through a project-operated proxy in this version.
- Up to 20 chats and their referenced images stay on your device, ordered by
  their latest message (creation for empty chats). Older chats are automatically
  deleted, including existing history on startup; manual deletion is available.
  Incognito use is disabled. No cloud sync or student profile is created.

## What is stored, and where

| Data | Where | Lifetime |
|---|---|---|
| Language settings and the private development endpoint/key | `chrome.storage.local` on your device | until you clear it / remove the extension |
| The cropped screenshot of your selection | `chrome.storage.session` (RAM-backed) | until the browser session ends; at most the last 8 captures are kept |
| Saved conversation text, generated replies/statuses and selected image Blobs | extension-origin IndexedDB on this device | until automatic removal beyond the newest 20 chats, History → Delete, clearing extension data or removing the extension; browser storage can fail or be evicted |
| Local generation timestamp and writer recovery metadata | IndexedDB | retained locally with the extension; not a user identity or telemetry |

History offers a storage usage display and an in-app deletion confirmation.
Images referenced by another retained conversation are kept. JSON export is
not offered. Copied text is independent of the local saved chat.
Transient capture copies can remain until the session cache is pruned or the
browser session ends. If storage fails, the latest visible answer may be
unsaved: copy before closing or navigating.

The private development key is stored locally, never synchronized to a cloud
account, and excluded from conversation records and the ordinary settings UI. A key baked into another build is still present in
that build and extractable; it is not protected server-side.

## What is sent, and to whom

When you ask a question, the extension sends **the cropped image of the region
you selected**, your question/attempt, a bounded selection of past turns, and
generated task/system instructions **directly from
your browser to the AI endpoint** (by default `https://openrouter.ai/api/v1`).
The private development connection authenticates with a runtime key. Requests
are subject to the privacy policy of that
provider (e.g. OpenRouter and the model vendor behind the chosen model). Study
Buddy does not proxy or transmit telemetry about this request. Source turns and
replies are retained locally as described above. Provider retention is governed
by that provider, not by local History → Delete.

Requests include at most 12 turns, 32,000 text characters and two images of at
most 4 MiB each; required oversized input is refused before transmission.
Incomplete/superseded replies are not treated as complete context. Model
fallback occurs only on explicit availability errors before any output; no
automatic restart after ambiguous interruption. The client ten-second interval
is UX, not a trusted spending/abuse control. Public shared-key release is blocked
on TD-06 and budget/hosting decisions.

No other page content is read or transmitted. The extension does not scan pages
in the background; the selection overlay is injected only when you start a
capture, and the screenshot is taken only after you finish dragging a region.

## Permissions and why they exist

- **activeTab** — to capture the visible tab, only after you ask for a selection.
- **scripting** — to inject the selection overlay on demand. There is no
  always-on content script.
- **storage** — to keep your settings/panel size (local) and transient captures
  (session); saved conversations use IndexedDB.
- **optional host access (`<all_urls>`)** — requested per site, at runtime, only
  when a capture needs a tab you did not invoke on. It is never requested at
  install time.
- **commands** — the keyboard shortcut to start a selection.

Chrome forbids any extension from capturing its own pages (`chrome://…`), the
Chrome Web Store, and other privileged pages; Study Buddy tells you so honestly
instead of retrying.

## Children’s privacy

Audience/age policy remains OPEN (D-11 in ToDo.md). This draft does not certify
children's privacy compliance. Review the audience and provider handling before
any public release; saved material and transmission follow the rules above.

## Changes

If this policy changes, the “Last updated” date above changes and the new text
ships with the extension.

## Contact

_Replace with your support email before publishing._ For questions about this
policy, contact: **you@example.com**.
