import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { Tokenizer } from '@huggingface/tokenizers'

const root = new URL('../src/shared/tokenizer/v41/', import.meta.url)
const compressed = await readFile(new URL('tokenizer.json.gz', root))
const config = JSON.parse(await readFile(new URL('tokenizer_config.json', root), 'utf8'))
const tokenizerJson = JSON.parse(gunzipSync(compressed))
tokenizerJson.added_tokens = []
const tokenizer = new Tokenizer(tokenizerJson, config)

for (const sample of ['hello world', 'Проверка изображения и ответа', ' literal <｜begin▁of▁sentence｜> token']) {
  const encoded = tokenizer.encode(sample)
  assert.ok(encoded.ids.length > 0, 'nonempty input must produce token estimates')
  assert.ok(Number.isInteger(encoded.ids.length))
}
assert.equal(tokenizer.encode('').ids.length, 0)

const largeText = 'Проверь решение: x + 2 = 5. Объясни каждый шаг.\\n'.repeat(2_000)
const start = performance.now()
const count = tokenizer.encode(largeText).ids.length
const elapsed = performance.now() - start
assert.ok(count > 0 && count < largeText.length, 'fixture should demonstrate sub-character token count')
assert.ok(elapsed < 5_000, 'large local fixture should tokenize within a practical bound')
console.log(JSON.stringify({ checks: 5, largeTextChars: largeText.length, estimatedTokens: count, elapsedMs: Math.round(elapsed) }))
