const extensionId = new URLSearchParams(location.search).get('id')
const pageTitle = document.querySelector('#page-title')
const pinGuide = document.querySelector('#pin-guide')
const showPinGuide = document.querySelector('#show-pin-guide')
let manualOverride = false
let timer

function validExtensionId(value) {
  return /^[a-p]{32}$/.test(value ?? '')
}

function setPinned(pinned) {
  pageTitle.textContent = pinned ? 'Study Buddy is ready' : 'Study Buddy is installed'
  showPinGuide.hidden = !pinned
  showPinGuide.setAttribute('aria-expanded', String(manualOverride))
  showPinGuide.textContent = manualOverride ? 'Hide pin guide' : 'Show how to pin it'
  pinGuide.hidden = pinned && !manualOverride
}

function checkPinState() {
  if (document.hidden) return
  if (!validExtensionId(extensionId) || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    setPinned(false)
    return
  }
  chrome.runtime.sendMessage(extensionId, { type: 'GET_PIN_STATE' }, response => {
    if (chrome.runtime.lastError || !response || typeof response.pinned !== 'boolean') {
      setPinned(false)
      return
    }
    setPinned(response.pinned)
  })
}

showPinGuide.addEventListener('click', () => {
  manualOverride = !manualOverride
  pinGuide.hidden = !manualOverride
  showPinGuide.setAttribute('aria-expanded', String(manualOverride))
  showPinGuide.textContent = manualOverride ? 'Hide pin guide' : 'Show how to pin it'
})

function startPolling() {
  window.clearInterval(timer)
  if (document.hidden) return
  checkPinState()
  timer = window.setInterval(checkPinState, 1500)
}

startPolling()
document.addEventListener('visibilitychange', startPolling)
window.addEventListener('pageshow', startPolling)
window.addEventListener('pagehide', () => window.clearInterval(timer))
