import assert from 'node:assert/strict'
import { createServer } from 'vite'

const root = process.cwd()
const vite = await createServer({ configFile: false, root, appType: 'custom', server: { middlewareMode: true } })
try {
  const protocol = await vite.ssrLoadModule('/src/shared/gateway-protocol.ts')
  const samples = [
    'hello world',
    'Проверка изображения и ответа',
    '😀🧪: non-ASCII symbols',
    'function solve(x) { return (x + 2) / 3 }',
    'random_identifier_9384756102938475610293847561029384756102938475610',
  ]
  for (const sample of samples) {
    const count = protocol.estimateTextTokens(sample)
    assert.ok(Number.isSafeInteger(count) && count > 0, 'non-empty text must receive a finite approximate estimate')
  }
  assert.ok(protocol.estimateTextTokens('!!!') > protocol.estimateTextTokens('abc'), 'punctuation-heavy text must receive a nonzero estimate')
  assert.ok(protocol.estimateTextTokens('Проверь решение: x + 2 = 5. Объясни каждый шаг.\n'.repeat(2_000)) < protocol.GATEWAY_LIMITS.inputTokens,
    'ordinary long multilingual text remains within the nominal input budget')

  const input = {
    requestId: 'contract-request-0001',
    task: 'ask',
    answerLanguage: 'en',
    uiLanguage: 'en',
    titleNeeded: false,
    taskInput: 'Help with 😀 this step',
    messages: [
      { role: 'assistant', content: 'Earlier explanation' },
      { role: 'user', content: [
        { type: 'text', text: 'Untrusted client text is replaced' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      ] },
    ],
  }
  const prepared = protocol.prepareGatewayGeneration(input)
  assert.deepEqual(prepared.messages.at(-1).content, [
    { type: 'text', text: input.taskInput },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
  ])
  assert.equal(prepared.estimatedInputTokens, protocol.estimateInputTokens(prepared.messages))
  assert.ok(protocol.gatewayRequestBytes(input) > JSON.stringify(input).length, 'request preflight counts UTF-8 bytes, including non-ASCII text')
  console.log('CONTEXT ESTIMATOR CONTRACTS OK — multilingual/code/punctuation estimates, canonical preview and exact UTF-8 request bytes')
} finally {
  await vite.close()
}
