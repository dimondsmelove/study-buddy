import { createBackend } from './app'
import { loadBackendConfig } from './config'

const config = loadBackendConfig()
const backend = createBackend(config)
backend.server.listen(config.port, config.host, () => {
  console.info(JSON.stringify({ event: 'backend.listening', host: config.host, port: config.port }))
})

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  void backend.close().then(() => process.exit(0), () => process.exit(1))
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
