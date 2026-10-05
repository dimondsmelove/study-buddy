# Study Buddy — Privacy Policy

_Last updated: 2026-10-05_

Study Buddy is a browser extension that lets you select a region of a web page
and ask an AI model about it. This policy explains exactly what leaves your
device and what does not. It is short because the extension collects nothing.

## Summary

- We run **no servers** and have **no accounts**.
- We collect **no analytics, no telemetry, and no personal data**.
- There is nothing to configure: the extension ships ready to use.
- The **only** thing sent anywhere is the screenshot region you explicitly
  select, and it goes **directly from your browser to the AI provider** (by
  default, OpenRouter). Nothing passes through us and we never see it.

## What is stored, and where

| Data | Where | Lifetime |
|---|---|---|
| Language settings (and, if you optionally set one, your own endpoint/key) | `chrome.storage.local` on your device | until you clear it / remove the extension |
| The cropped screenshot of your selection | `chrome.storage.session` (RAM-backed) | until the browser session ends; at most the last 8 captures are kept |

If you use the built-in key, no key is stored on your device. If you override it
with your own, that key is stored locally and never synchronized to a cloud
account.

## What is sent, and to whom

When you ask a question, the extension sends **the cropped image of the region
you selected**, your question, and a short system instruction **directly from
your browser to the AI endpoint** (by default `https://openrouter.ai/api/v1`).
The request is authenticated with an access key managed by the developer (or
your own key, if you set one). It is subject to the privacy policy of that
provider (e.g. OpenRouter and the model vendor behind the chosen model). Study
Buddy does not proxy, log, or copy this request.

No other page content is read or transmitted. The extension does not scan pages
in the background; the selection overlay is injected only when you start a
capture, and the screenshot is taken only after you finish dragging a region.

## Permissions and why they exist

- **activeTab** — to capture the visible tab, only after you ask for a selection.
- **scripting** — to inject the selection overlay on demand. There is no
  always-on content script.
- **storage** — to keep your settings (local) and the transient crop (session).
- **optional host access (`<all_urls>`)** — requested per site, at runtime, only
  when a capture needs a tab you did not invoke on. It is never requested at
  install time.
- **commands** — the keyboard shortcut to start a selection.

Chrome forbids any extension from capturing its own pages (`chrome://…`), the
Chrome Web Store, and other privileged pages; Study Buddy tells you so honestly
instead of retrying.

## Children’s privacy

The extension is a general-purpose study tool and is not directed at children
under 13. It collects no data from anyone.

## Changes

If this policy changes, the “Last updated” date above changes and the new text
ships with the extension.

## Contact

_Replace with your support email before publishing._ For questions about this
policy, contact: **you@example.com**.
