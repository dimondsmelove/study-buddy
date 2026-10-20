# Study Buddy — Privacy Policy

_Last updated: 2026-10-16 · gateway integration draft; public hosting, contact
details and store disclosures must be completed before publication._

Study Buddy lets you select a region of a web page and ask an AI model about
it. Selected images and typed text may contain personal information. Review
what you select before sending it.

## Summary

- Your latest 20 conversations, selected images and available per-answer token
  usage stay in this browser. There is no cloud conversation sync or student
  profile.
- The gateway version sends a bounded selection of your conversation through
  the configured Study Buddy backend to OpenRouter and the model provider.
  The OpenRouter credential stays on the backend.
- There is no visible account registration. A persistent anonymous access
  session identifies requests for service limits; it does not identify a
  unique person or prevent someone from resetting an installation.
- The backend temporarily processes request content and streams the answer.
  It does not save conversation text, selected images or generated answers in
  its application database or ordinary logs.
- The backend retains limited operational records for access, cooldown,
  concurrency, duplicate-request prevention and recovery. These records are
  separate from your local conversation history.

## What stays in your browser

| Data | Location | Lifetime |
|---|---|---|
| Language/panel settings, backend configuration and anonymous access token | Extension-local storage; not browser sync | Until cleared, renewed or the extension is removed |
| Transient selected screenshots | Extension session storage; up to the last eight captures | Until pruned or the browser session ends |
| Saved messages, image Blobs, response status and available model/token/cost usage | Extension-origin IndexedDB | Up to the latest 20 chats, until automatic pruning, manual deletion, clearing browser data or extension removal |
| Local generation/cooldown and recovery state | Extension-origin IndexedDB | Alongside the local extension data |

History orders conversations by their latest non-capture message, using
creation time for an empty conversation. Viewing a chat or selecting another
image alone does not promote its position. Older chats are automatically
deleted, including previously accumulated chats on startup. An image remains
while another retained chat still references it.

History provides manual deletion and storage usage information. JSON export
is not offered. Copied text is independent of the saved chat. Browser storage
can fail or be evicted; if an answer cannot be saved, copy it before closing.
Incognito is disabled. Local history does not automatically move between
devices and can be lost when extension data is removed.

## What is sent

Completing a selection saves an image locally. Selecting, opening History or
viewing a saved conversation does not by itself start an AI generation.

When you explicitly start a task or send a question, the extension selects
a bounded context locally; excluded older messages are muted with a reuse action. It sends the selected
user/assistant messages, needed image data and task/language metadata to the
configured backend. Excluded history is not uploaded for server-side
selection. Draft text is not uploaded on each keystroke.

The backend validates the request, creates its own system/current-task
instructions and model parameters, and forwards the request to OpenRouter.
Availability fallback before output can use another configured model and
provider. OpenRouter and those providers have their own data-retention
policies; deleting local History does not delete their records.

The application targets an approximate 200,000-input-token budget with a
20,000-token reserve. This estimate is not a provider-exact token count.
Images are limited to 4 MiB each and the total HTTP request to 32 MiB;
oversized selected context is refused. Actual token usage and cost returned
by the provider are attached to the answer when available. Missing usage
after an interruption is unknown, not zero. Output limits depend on the task.

Stop and Close cancel the active connection and request upstream cancellation.
Already completed provider processing can still be billed. The backend does
not automatically restart an ambiguous or partially streamed operation.

No other page content is intentionally collected. The extension does not
scan pages in the background; its selection overlay and chat host are
injected on explicit capture or History actions.

## Backend operational records

The backend stores access-session identifiers, token hashes, expiry and
cooldown timestamps. Sessions expire after 30 days unless renewed; renewal
retains the same installation identity and service limits. A separate durable
installation ID and hashed secret allow the extension to recover a session
after bearer expiry. Clearing extension data, creating a new profile or
reinstalling may create a new anonymous installation; it does not delete the
previous server-side identity or its budget ledger.

The backend also stores monthly per-installation spent and reserved amounts,
charge status and provider generation IDs needed to reconcile uncertain costs.
These identity and ledger records have no automatic expiry. The budget is $5 per
anonymous installation per UTC calendar month, with a $0.275 reserve per
generation. The reserve is based on a maximum 1,050,000 prompt tokens at
$0.25/M plus 16,384 output tokens at $0.75/M ($0.274788, rounded up). Final
provider usage replaces the reserve when available; unresolved usage remains
reserved for reconciliation. The request carries provider-side maximum price
limits. Prompts, model and output cap are unchanged.

Expired bearer sessions and issuance buckets are physically cleaned lazily at
startup and on session issuance or generation admission; an idle database can
retain expired records until then.

Duplicate-request protection uses an operation identifier, a fingerprint of
the accepted request, status and timestamps for a 24-hour window. Finished
records become eligible for deletion after that window and are physically
removed by the same activity-triggered cleanup. These records
do not contain the conversation, image or answer. Within that window, repeating
the same operation does not start another model request.

For limits on issuing new sessions, the server receives the connection IP and
derives an hourly HMAC identifier. Issuance records count only within the last
hour and are eligible for removal after that hour. The application does not save the raw IP
in its database or ordinary logs. This identifier is pseudonymous, not a claim
of irreversible anonymization. Shared networks can share an issuance limit.

These technical records are not a learning profile or advertising analytics.
Clearing local chats does not remove still-needed operational records. Session and issuance records follow their stated cleanup windows; installation identity and budget ledger records persist without automatic deletion. The backend does not store the extension's raw installation secret. Public deployment must also configure proxy,
hosting and error-reporting logs consistently with these disclosures.

## Permissions

- **activeTab** — capture the visible tab on an explicit selection action, or
  show saved History after an explicit toolbar action.
- **contextMenus** — Show history in the toolbar icon's context menu.
- **scripting** — inject the selection overlay/chat host on demand.
- **storage** — local settings/access state and transient session captures;
  saved conversations/images use IndexedDB.
- **clipboardWrite** — copy an answer after an explicit Copy action.
- **optional site access** — requested per site when needed for capture; the
  screenshot remains gated to the intended origin.
- **keyboard command** — start selection with Ctrl+Shift+Y (Command+Shift+Y
  on macOS).

Backend access/CORS configuration must match the deployed extension and
service. Persistent access to all browsing sites is not required for the
gateway itself. Privileged browser pages and the extension store cannot be
captured.

## Children and publication

The initial audience/age policy remains an explicit product decision. This
draft does not certify children's privacy compliance or universal educational
accuracy. The local integration does not itself publish a backend or extension.

## Contact

Replace this placeholder before public release: **you@example.com**.
Publish this policy at the actual service's public privacy URL and reconcile
the store privacy fields with the deployed behavior and hosting policies.
