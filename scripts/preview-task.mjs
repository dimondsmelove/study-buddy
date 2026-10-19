// Task metadata is intentionally absent from the provider payload while the
// app has no approved instruction text. Do not infer Hint/Check from empty or
// incidental prompt prefixes in this transitional preview.
export function classifyPreviewTask() {
  return 'solve'
}
