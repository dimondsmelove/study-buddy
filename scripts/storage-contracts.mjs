import assert from 'node:assert/strict'
import http from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const compiled = await build({ stdin: { contents: "export * from './src/shared/conversation-store'; export * from './src/shared/conversations'; export * from './src/shared/gateway-protocol'", resolveDir: process.cwd() }, bundle: true, format: 'iife', globalName: 'contracts', write: false })
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
    const nextImage = { id: 'next-image', data: new Blob(['next image'], { type: 'image/png' }), createdAt: image.createdAt + 1 }
    await c.attachCapture(first.id, nextImage)
    await c.attachCapture(first.id, { ...image, data: new Blob(['replacement image'], { type: 'image/png' }) })
    const captured = await c.getConversation(first.id)
    const captureTurnCount = captured.turns.filter(turn => turn.kind === 'capture' && turn.id === image.id).length
    const captureOrder = captured.turns.filter(turn => turn.kind === 'capture').map(turn => turn.attachmentId)
    const capturePointerStable = captured.activeAttachmentId === nextImage.id
    const captureBlobStable = await (await c.getAttachment(image.id)).data.text() === 'image fixture'
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
    const projectionOptions = { countTokens: text => text.length, systemPrompt: 'Study Buddy' }
    const generationOptions = { generation: { task: 'ask', answerLanguage: 'en', uiLanguage: 'en', titleNeeded: false, taskInput: 'question 2' } }
    const many = { ...first, turns: [] }
    for (let i = 0; i < 40; i++) many.turns.push({ ...user, id: 'turn-' + i, text: 'turn ' + i, kind: 'ask', attachmentId: 'task-' + Math.floor(i / 3) })
    const bounded = c.contextTurns(many, projectionOptions)
    let oversizeRejected = false
    try { c.contextTurns({ ...first, activeAttachmentId: 'too-large', turns: [{ ...user, attachmentId: 'too-large', text: 'x'.repeat(190_001) }] }, projectionOptions) } catch { oversizeRejected = true }
    const captureIds = ['shared-image', 'next-image', 'capture-c']
    const captures = captureIds.map((id, index) => ({ ...user, id: `capture-turn-${id}`, text: '', kind: 'capture', attachmentId: id, createdAt: Date.now() + index }))
    const questions = ['ask-a', 'ask-b', 'ask-c'].map((id, index) => ({ ...user, id, text: `question ${index}`, attachmentId: captures[index].attachmentId, createdAt: Date.now() + index + 3 }))
    const answers = questions.map((turn, index) => ({ ...turn, id: `answer-${index}`, role: 'assistant', status: 'complete', replyTo: turn.id, attachmentId: undefined, createdAt: Date.now() + index + 6 }))
    const dialog = { ...first, activeAttachmentId: 'capture-c', turns: [captures[0], questions[0], answers[0], captures[1], questions[1], answers[1], captures[2], questions[2]] }
    const projection = c.contextProjection(dialog, generationOptions)
    const projectedContext = await c.requestContext(async () => new Blob(['thread image'], { type: 'image/png' }), projection)
    const includedIds = projection.entries.filter(entry => entry.included).map(entry => entry.turn.id)
    const excludedReasons = Object.fromEntries(projection.entries.filter(entry => !entry.included).map(entry => [entry.turn.role === 'assistant' ? entry.turn.id : entry.turn.attachmentId === 'shared-image' ? entry.turn.kind === 'capture' ? 'capture-a' : 'ask-a' : entry.turn.id, entry.reason]))
    const projectedImages = projectedContext.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(part => part.type === 'image_url').length
    const firstImageOnly = Array.isArray(projectedContext.messages[0].content) && projectedContext.messages[0].content.length === 1 && projectedContext.messages[0].content[0].type === 'image_url'
    const preparedPreview = c.prepareGatewayGeneration({ ...generationOptions.generation, requestId: 'storage-preview', messages: projectedContext.messages })
    const previewPayloadMatch = projectedContext.messages.length === projection.turns.length && projectedImages === projection.images.size && preparedPreview.estimatedInputTokens === projection.estimatedInputTokens
    const images = { ...first, turns: ['old', 'recent', 'current'].map((id) => ({ ...user, id, attachmentId: id })) }
    const sourceSnapshot = JSON.stringify(images)
    const imageProjection = c.contextProjection(images, projectionOptions)
    const context = await c.requestContext(async () => image.data, imageProjection)
    const imageCount = context.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url').length
    let imageLarge = false, imageMissing = false
    try { await c.requestContext(async () => new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]), imageProjection) } catch (err) { imageLarge = err.message === 'context.imageLarge' }
    try { await c.requestContext(async () => undefined, imageProjection) } catch (err) { imageMissing = err.message === 'context.imageMissing' }
    const budgetTurns = [
      { ...user, id: 'capture-old', kind: 'capture', text: '', attachmentId: 'old-task' },
      { ...user, id: 'old-work', kind: 'ask', text: 'o'.repeat(100_000), attachmentId: 'old-task' },
      { ...user, id: 'capture-current', kind: 'capture', text: '', attachmentId: 'current-task' },
      { ...user, id: 'current-work', kind: 'ask', text: 'n'.repeat(90_000), attachmentId: 'current-task' },
    ]
    const taskProjection = c.contextProjection({ ...first, activeAttachmentId: 'current-task', turns: budgetTurns }, projectionOptions)
    return { includedIds, excludedReasons, taskIncluded: taskProjection.turns.map(turn => turn.id), taskReason: taskProjection.entries[0].reason, estimate: taskProjection.estimatedInputTokens, projectedImages, firstImageOnly, previewPayloadMatch, captureTurnCount, captureOrder, capturePointerStable, captureBlobStable, captureDoesNotPromote, recovered: recovered.turns.at(-1), generatedTitle: recovered.title, titleGeneratedAt: recovered.titleGeneratedAt, state, bytes, quotaRejected, preserved, sharedKept, orphanRemoved, empty, bounded: { count: bounded.turns.length, ids: bounded.turns.map(t => t.id), omitted: bounded.omitted }, oversizeRejected, imageCount, imageLarge, imageMissing, contextPreserved: JSON.stringify(images) === sourceSnapshot, cooldown: [c.cooldownRemaining(100, 10099), c.cooldownRemaining(100, 10100)] }
  })
  assert.equal(result.recovered.text, 'partial response')
  assert.equal(result.recovered.status, 'interrupted')
  assert.equal(result.generatedTitle, 'Linear equations')
  assert.equal(typeof result.titleGeneratedAt, 'number')
  assert.equal(result.state.generation, undefined)
  assert.ok(result.bytes > 0)
  assert.equal(result.includedIds.length, 8, 'all recent whole task groups fit the token estimate')
  assert.deepEqual(result.excludedReasons, {})
  assert.equal(result.projectedImages, 3)
  assert.equal(result.firstImageOnly, true, 'capture-only context message contains only its image part')
  assert.equal(result.previewPayloadMatch, true)
  assert.equal(result.captureTurnCount, 1, 'repeated capture handoff adds one image turn')
  assert.deepEqual(result.captureOrder, ['shared-image', 'next-image'], 'late duplicate handoff keeps capture order')
  assert.equal(result.capturePointerStable, true, 'late duplicate handoff keeps the current task image')
  assert.equal(result.captureBlobStable, true, 'late duplicate handoff does not replace the saved blob')
  assert.equal(result.captureDoesNotPromote, true, 'capture does not promote conversation activity')
  for (const key of ['quotaRejected', 'preserved', 'sharedKept', 'orphanRemoved', 'empty', 'oversizeRejected']) assert.equal(result[key], true, key)
  assert.equal(result.bounded.count, 40)
  assert.equal(result.bounded.omitted, 0)
  assert.deepEqual(result.taskIncluded, ['capture-current', 'current-work'])
  assert.equal(result.taskReason, 'olderTask')
  assert.ok(result.estimate < 200_000)
  assert.deepEqual(result.cooldown, [1, 0])
  assert.equal(result.imageCount, 3)
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
  console.log('PASS IndexedDB commit/rollback/recovery/reload/attachment GC; 20-chat message-activity retention; protected writer + same-ms new chat; deletion state repair; token-budgeted whole-task context; cooldown boundaries')
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
