const params = new URLSearchParams(location.search)
const extensionId = params.get('id')
const pinnedHint = params.get('pinned') === '1' ? true : params.get('pinned') === '0' ? false : null
const body = document.body
const modeLinks = [...document.querySelectorAll('[data-switch]')]
let manualMode = false
let livePinned = null
let interval = 0
let inFlight = false
let stopped = false
let pageActive = !document.hidden

function validExtensionId(value) {
  return /^[a-p]{32}$/.test(value ?? '')
}

function hashMode() {
  const value = location.hash.slice(1)
  return value === 'pin' || value === 'usage' ? value : null
}

function renderMode(mode) {
  body.dataset.mode = mode
  modeLinks.forEach(link => {
    if (link.dataset.switch === mode) link.setAttribute('aria-current', 'step')
    else link.removeAttribute('aria-current')
  })
  document.querySelector('#page-title').textContent = mode === 'usage' ? 'Study Buddy is ready' : 'Study Buddy Installed'
}

function automaticMode() {
  if (livePinned !== null) return livePinned ? 'usage' : 'pin'
  if (pinnedHint !== null) return pinnedHint ? 'usage' : 'pin'
  return 'pin'
}

function applyAutomaticMode() {
  if (manualMode) return
  renderMode(hashMode() ?? automaticMode())
}

function chooseMode(mode) {
  manualMode = true
  stopPolling()
  renderMode(mode)
  const hash = `#${mode}`
  if (location.hash !== hash) history.replaceState(null, '', hash)
}

function stopPolling() {
  if (interval) window.clearInterval(interval)
  interval = 0
}

function unreachable() {
  stopped = true
  stopPolling()
}

function checkPinState() {
  if (stopped || manualMode || !pageActive || inFlight) return
  if (!validExtensionId(extensionId) || typeof chrome === 'undefined' || typeof chrome.runtime?.sendMessage !== 'function') {
    unreachable()
    return
  }
  inFlight = true
  try {
    chrome.runtime.sendMessage(extensionId, { type: 'GET_PIN_STATE' }, response => {
      inFlight = false
      const transportError = chrome.runtime.lastError
      if (transportError) { unreachable(); return }
      if (stopped || manualMode || !pageActive) return
      if (typeof response?.pinned === 'boolean') {
        livePinned = response.pinned
        applyAutomaticMode()
      }
    })
  } catch {
    inFlight = false
    unreachable()
  }
}

function startPolling() {
  stopPolling()
  pageActive = !document.hidden
  if (!pageActive || stopped || manualMode) return
  checkPinState()
  if (!pageActive || stopped || manualMode) return
  interval = window.setInterval(checkPinState, 1500)
}

modeLinks.forEach(link => link.addEventListener('click', event => {
  event.preventDefault()
  chooseMode(link.dataset.switch)
}))
window.addEventListener('hashchange', () => {
  const mode = hashMode()
  if (mode) chooseMode(mode)
})
if (hashMode()) {
  manualMode = true
  renderMode(hashMode())
} else applyAutomaticMode()
startPolling()
document.addEventListener('visibilitychange', startPolling)
window.addEventListener('pageshow', startPolling)
window.addEventListener('pagehide', () => { pageActive = false; stopPolling() })
