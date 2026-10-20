# Private live integration and quality notes — 2026-10-20

These two calls used the installed Study Buddy extension, the private laptop
backend, and openai/gpt-6-luna. They cost $0.0001996 total. The backend and
extension routing worked; that does not establish answer quality.

## Text UI case

A request through the installed chat UI asked for 17 + 25. The saved answer was
42 and the conversation completed. Routing passed. The answer was numeric-only,
so this call did not assess compliance with an answer language; it was the same
text call, not an additional language probe.

## Fixed Solve image case

The input PNG visibly reads “Calculate: 18 × 7 = ?”. The model invented “-2”
and its final answer was 124, instead of 126. The saved Markdown confirms 124.
The image SHA-256 matched the bytes of the stored attachment, so this is a model
quality failure, not evidence of a capture/attachment mismatch. An initial
substring probe falsely accepted an intermediate “126”; the corrected durable
record marks answerCorrect=false and routingPassed=true and retains the raw result.
No prompt change or quality fix was made.

The hidden-target screenshot attempt failed/timed out. Only the agent-owned CDP
target was closed; there is no visual acceptance claim.

The original local history baseline (13 conversations, 12 attachments) was
preserved. It now contains 15 conversations and 13 attachments, including the
two test conversations.

## Owner-only evidence

The following runtime evidence remains outside the repository under the
owner-only acceptance directory:

- /home/diamondsepticon/.local/share/study-buddy/private/acceptance-20261020/text-ui.json
- /home/diamondsepticon/.local/share/study-buddy/private/acceptance-20261020/vision-ui.json
- /home/diamondsepticon/.local/share/study-buddy/private/acceptance-20261020/vision-input.png
