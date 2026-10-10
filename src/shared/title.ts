export const RESPONSE_TITLE_PREFIX = '[[STUDY_BUDDY_TITLE]]'
export const MAX_CONVERSATION_TITLE = 80

export function normalizeGeneratedTitle(value: string): string | undefined {
  const title = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const length = Array.from(title).length
  return title && length <= MAX_CONVERSATION_TITLE ? title : undefined
}

/** Hides a possible first-line title envelope until it is complete or disproved. */
export function createResponseTitleParser(): {
  push(chunk: string): string
  finish(): { text: string; title?: string }
  readonly title?: string
} {
  let mode: 'prefix' | 'title' | 'body' | 'plain' = 'prefix'
  let prefixBuffer = ''
  let titleLine = ''
  let answerTitle: string | undefined
  let finished = false

  return {
    get title() { return answerTitle },
    push(chunk: string): string {
      if (finished || !chunk) return ''
      if (mode === 'plain' || mode === 'body') return chunk
      let visible = ''
      for (const char of chunk) {
        if (mode === 'plain' || mode === 'body') { visible += char; continue }
        if (mode === 'prefix') {
          prefixBuffer += char
          if (RESPONSE_TITLE_PREFIX.startsWith(prefixBuffer)) {
            if (prefixBuffer === RESPONSE_TITLE_PREFIX) {
              prefixBuffer = ''
              mode = 'title'
            }
            continue
          }
          mode = 'plain'
          visible += prefixBuffer
          prefixBuffer = ''
          continue
        }
        if (mode === 'title') {
          if (char === '\n') {
            answerTitle = normalizeGeneratedTitle(titleLine.endsWith('\r') ? titleLine.slice(0, -1) : titleLine)
            titleLine = ''
            mode = 'body'
          } else {
            titleLine += char
          }
          continue
        }
      }
      return visible
    },
    finish(): { text: string; title?: string } {
      if (finished) return { text: '', ...(answerTitle ? { title: answerTitle } : {}) }
      finished = true
      if (mode === 'prefix') {
        // A strict prefix of the reserved marker is an incomplete control fragment.
        if (RESPONSE_TITLE_PREFIX.startsWith(prefixBuffer)) prefixBuffer = ''
        mode = 'plain'
        return { text: prefixBuffer }
      }
      if (mode === 'title') {
        mode = 'plain'
        return { text: titleLine }
      }
      mode = 'plain'
      return { text: '', ...(answerTitle ? { title: answerTitle } : {}) }
    },
  }
}
