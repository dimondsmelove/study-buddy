import tokenizerUrl from './tokenizer/v41/tokenizer.json.gz?url'
import tokenizerConfigUrl from './tokenizer/v41/tokenizer_config.json?url'

type CountTokens = (text: string) => number
let counter: Promise<CountTokens> | undefined

/** Load the lightweight JS tokenizer and compressed V4.1 vocabulary on demand. */
export function loadDeepSeekTokenCounter(): Promise<CountTokens> {
  if (!counter) counter = createCounter()
  return counter
}

async function createCounter(): Promise<CountTokens> {
  const [tokenizerResponse, configResponse, tokenizerModule] = await Promise.all([
    fetch(tokenizerUrl),
    fetch(tokenizerConfigUrl),
    import('@huggingface/tokenizers'),
  ])
  if (!tokenizerResponse.ok || !configResponse.ok || !('DecompressionStream' in globalThis)) {
    throw new Error('context.tokenizerUnavailable')
  }
  const tokenizerJson = await new Response(tokenizerResponse.body!.pipeThrough(new DecompressionStream('gzip'))).json() as Record<string, unknown>
  const tokenizerConfig = await configResponse.json()
  // Treat user supplied strings that look like control tokens as ordinary text.
  tokenizerJson.added_tokens = []
  const tokenizer = new tokenizerModule.Tokenizer(tokenizerJson, tokenizerConfig)
  return (text) => tokenizer.encode(text).ids.length
}
