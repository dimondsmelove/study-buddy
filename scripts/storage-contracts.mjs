import assert from 'node:assert/strict'
import http from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const compiled = await build({ stdin: { contents: "export * from './src/shared/conversation-store'; export * from './src/shared/conversations'", resolveDir: process.cwd() }, bundle: true, format: 'iife', globalName: 'contracts', write: false })
const server = http.createServer((_, res) => res.end('<!doctype html><title>Isolated storage fixtures</title>'))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.addScriptTag({ content: compiled.outputFiles[0].text })
  const result = await page.evaluate(async () => {
    const c = contracts
    const first = await c.createConversation('First')
    const second = await c.createConversation('Second')
    const image = { id: 'shared-image', data: new Blob(['image fixture'], { type: 'image/png' }), createdAt: Date.now() }
    await c.attachCapture(first.id, image)
    await c.attachCapture(second.id, image)
    const user = { id: 'user', role: 'user', text: '2x+6=10', kind: 'ask', locale: 'en', promptVersion: 'fixture', createdAt: Date.now(), attachmentId: image.id }
    const assistant = { ...user, id: 'assistant', role: 'assistant', text: '', status: 'streaming', replyTo: user.id }
    const generation = await c.startGeneration(first.id, user, assistant)
    await c.updateReply(generation, 'partial response', 'streaming')
    await c.recoverGeneration()
    const recovered = await c.getConversation(first.id)
    const state = await c.getConversationState()
    const bytes = await c.conversationUsage()
    const before = JSON.stringify(recovered)
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function () { throw new DOMException('fixture quota', 'QuotaExceededError') }
    // The callback exception aborts its transaction; capture must not look saved.
    const handler = (event) => { event.preventDefault() }
    window.addEventListener('error', handler)
    let quotaRejected = false
    try { await c.attachCapture(first.id, { ...image, id: 'quota-image' }) } catch { quotaRejected = true }
    IDBObjectStore.prototype.put = originalPut
    window.removeEventListener('error', handler)
    const preserved = JSON.stringify(await c.getConversation(first.id)) === before
    await c.deleteConversation(first.id)
    const sharedKept = !!await c.getAttachment(image.id)
    await c.deleteConversation(second.id)
    const orphanRemoved = !await c.getAttachment(image.id)
    const empty = (await c.listConversations()).length === 0
    await c.createConversation('Survives reload')
    const many = { ...first, turns: [] }
    for (let i = 0; i < 40; i++) many.turns.push({ ...user, id: `turn-${i}`, text: `turn ${i}`, kind: i === 4 ? 'check' : 'ask', input: i === 4 ? 'x=2' : undefined })
    many.turns[30] = { ...many.turns[30], kind: 'check', input: 'different task attempt', attachmentId: 'other-task' }
    const bounded = c.contextTurns(many)
    let oversizeRejected = false
    try { c.contextTurns({ ...first, turns: [{ ...user, text: 'x'.repeat(32_001) }] }) } catch { oversizeRejected = true }
    const images = { ...first, turns: ['old', 'recent', 'current'].map((id) => ({ ...user, id, attachmentId: id })) }
    const sourceSnapshot = JSON.stringify(images)
    const context = await c.requestContext(images, async () => image.data)
    const imageCount = context.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url').length
    let imageLarge = false, imageMissing = false
    try { await c.requestContext(images, async () => new Blob([new Uint8Array(4 * 1024 * 1024 + 1)])) } catch (err) { imageLarge = err.message === 'context.imageLarge' }
    try { await c.requestContext(images, async () => undefined) } catch (err) { imageMissing = err.message === 'context.imageMissing' }
    return { recovered: recovered.turns.at(-1), state, bytes, quotaRejected, preserved, sharedKept, orphanRemoved, empty, bounded: { count: bounded.turns.length, ids: bounded.turns.map(t => t.id), omitted: bounded.omitted }, oversizeRejected, imageCount, imageLarge, imageMissing, contextPreserved: JSON.stringify(images) === sourceSnapshot, cooldown: [c.cooldownRemaining(100, 10099), c.cooldownRemaining(100, 10100)] }
  })
  assert.equal(result.recovered.text, 'partial response')
  assert.equal(result.recovered.status, 'interrupted')
  assert.equal(result.state.generation, undefined)
  assert.ok(result.bytes > 0)
  for (const key of ['quotaRejected', 'preserved', 'sharedKept', 'orphanRemoved', 'empty', 'oversizeRejected']) assert.equal(result[key], true, key)
  assert.equal(result.bounded.count, 12)
  assert.ok(result.bounded.ids.includes('turn-0'))
  assert.ok(result.bounded.ids.includes('turn-4'))
  assert.ok(result.bounded.ids.includes('turn-39'))
  assert.deepEqual(result.cooldown, [1, 0])
  assert.equal(result.imageCount, 2)
  for (const key of ['imageLarge', 'imageMissing', 'contextPreserved']) assert.equal(result[key], true, key)
  await page.reload()
  await page.addScriptTag({ content: compiled.outputFiles[0].text })
  assert.equal(await page.evaluate(async () => (await contracts.listConversations())[0].title), 'Survives reload')
  console.log('PASS IndexedDB commit/rollback/recovery/reload/attachment GC; bounded context; cooldown boundaries')
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
