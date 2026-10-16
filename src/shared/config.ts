import { normalizeGatewayUrl } from './gateway-url'

/** Public backend origin, selected at extension build time. No provider key is bundled. */
export const GATEWAY_URL = normalizeGatewayUrl(__SB_GATEWAY_URL__)
