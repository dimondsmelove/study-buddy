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
    const image = { id: 'shared-image', data: new Blob(['image fixture'], { type: 'image/png' }), createdAt: Date.now() + 1000 }
    const activityBeforeCapture = c.conversationActivityAt(first)
    await c.attachCapture(first.id, image)
    await c.attachCapture(first.id, image)
    const captured = await c.getConversation(first.id)
    const captureTurnCount = captured.turns.filter(turn => turn.kind === 'capture' && turn.id === image.id).length
    const captureDoesNotPromote = c.conversationActivityAt(captured) === activityBeforeCapture
    await c.attachCapture(second.id, image)
    const user = { id: 'user', role: 'user', text: '2x+6=10', kind: 'ask', locale: 'en', promptVersion: 'fixture', createdAt: Date.now(), attachmentId: image.id }
    const assistant = { ...user, id: 'assistant', role: 'assistant', text: '', status: 'streaming', replyTo: user.id }
    const generation = await c.startGeneration(first.id, user, assistant)
    await c.updateReply(generation, 'partial response', 'streaming', undefined, undefined, 'Linear equations')
    await c.updateReply(generation, 'partial response', 'streaming', undefined, undefined, 'Must not retitle')
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
    return { captureTurnCount, captureDoesNotPromote, recovered: recovered.turns.at(-1), generatedTitle: recovered.title, titleGeneratedAt: recovered.titleGeneratedAt, state, bytes, quotaRejected, preserved, sharedKept, orphanRemoved, empty, bounded: { count: bounded.turns.length, ids: bounded.turns.map(t => t.id), omitted: bounded.omitted }, oversizeRejected, imageCount, imageLarge, imageMissing, contextPreserved: JSON.stringify(images) === sourceSnapshot, cooldown: [c.cooldownRemaining(100, 10099), c.cooldownRemaining(100, 10100)] }
  })
  assert.equal(result.recovered.text, 'partial response')
  assert.equal(result.recovered.status, 'interrupted')
  assert.equal(result.generatedTitle, 'Linear equations')
  assert.equal(typeof result.titleGeneratedAt, 'number')
  assert.equal(result.state.generation, undefined)
  assert.ok(result.bytes > 0)
  assert.equal(result.captureTurnCount, 1, 'repeated capture handoff adds one image turn')
  assert.equal(result.captureDoesNotPromote, true, 'capture does not promote conversation activity')
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
  const retention = await page.evaluate(async () => {
    const c = contracts
    for (const row of await c.listConversations()) await c.deleteConversation(row.id)
    const rows = []
    for (let i = 0; i < 22; i++) rows.push(await c.createConversation(`Retention ${i}`))
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('study-buddy-conversations')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['conversations', 'attachments', 'state'], 'readwrite')
      const conversations = tx.objectStore('conversations')
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        row.createdAt = 1000 // same-ms creation tie
        row.updatedAt = 5000 - i // activity must ignore capture/reply updates
        row.turns = i === 1 ? [] : [{ id: `activity-${i}`, role: 'user', text: `topic ${i}`, kind: 'ask', createdAt: i === 0 ? 1001 : 1000 + i, locale: 'en', promptVersion: 'fixture' }]
        if (i === 1 || i === 4) row.activeAttachmentId = 'retention-shared'
        if (i === 2) row.turns[0].attachmentId = 'retention-orphan'
        conversations.put(row)
      }
      const attachments = tx.objectStore('attachments')
      for (const id of ['retention-shared', 'retention-orphan']) attachments.put({ id, data: new Blob(['fixture']), createdAt: 1 })
      tx.objectStore('state').put({ id: 'state', lastStartedAt: 0, lastConversationId: rows[2].id, generation: { conversationId: rows[0].id, turnId: 'active', requestId: 'writer' } })
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    const originalDelete = IDBObjectStore.prototype.delete
    const onError = event => event.preventDefault()
    window.addEventListener('error', onError)
    IDBObjectStore.prototype.delete = function (...args) {
      if (this.name === 'conversations') throw new DOMException('fixture prune failure', 'QuotaExceededError')
      return originalDelete.apply(this, args)
    }
    let pruneRejected = false
    try { await c.enforceConversationLimit(rows[1].id) } catch { pruneRejected = true }
    IDBObjectStore.prototype.delete = originalDelete
    window.removeEventListener('error', onError)
    const rollbackCount = (await c.listConversations()).length
    const rollbackState = await c.getConversationState()
    await c.enforceConversationLimit(rows[1].id)
    const retained = await c.listConversations()
    const state = await c.getConversationState()
    const shared = await c.getAttachment('retention-shared')
    const orphan = await c.getAttachment('retention-orphan')
    const keptIds = retained.map(row => row.id)
    const activityOrder = retained.map(row => Number(row.title.split(' ').at(-1)))
    return { count: retained.length, pruneRejected, rollbackCount, rollbackWriterPreserved: rollbackState.generation?.conversationId === rows[0].id, protectedWriter: keptIds.includes(rows[0].id), newEmptyProtected: keptIds.includes(rows[1].id), removedOld: !keptIds.includes(rows[2].id) && !keptIds.includes(rows[3].id), activityNewestFirst: activityOrder[0] === 21, stateRepaired: state.lastConversationId === rows[21].id, sharedAttachmentKept: !!shared, orphanAttachmentRemoved: !orphan }
  })
  assert.equal(retention.count, 20)
  assert.equal(retention.pruneRejected, true)
  assert.equal(retention.rollbackCount, 22)
  assert.equal(retention.rollbackWriterPreserved, true)
  for (const key of ['protectedWriter', 'newEmptyProtected', 'removedOld', 'activityNewestFirst', 'stateRepaired', 'sharedAttachmentKept', 'orphanAttachmentRemoved']) assert.equal(retention[key], true, key)
  const deleteRepair = await page.evaluate(async () => {
    const c = contracts
    const conversations = await c.listConversations()
    await c.selectConversation(conversations[0].id)
    await c.deleteConversation(conversations[0].id)
    return (await c.getConversationState()).lastConversationId === (await c.listConversations())[0].id
  })
  assert.equal(deleteRepair, true, 'manual deletion repairs selection using the activity-sorted list')
  console.log('PASS IndexedDB commit/rollback/recovery/reload/attachment GC; 20-chat message-activity retention; protected writer + same-ms new chat; deletion state repair; bounded context; cooldown boundaries')
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
