const params = new URLSearchParams(location.search)
const extensionId = params.get('id')
const pinSection = document.querySelector('#pin')
const skipButton = document.querySelector('#skip-pin')
const manualMode = params.get('manual') === '1'
let timer

function validExtensionId(value) {
  return /^[a-p]{32}$/.test(value ?? '')
}

function showPinGuide() {
  if (!manualMode && sessionStorage.getItem('skip-pin') !== '1') pinSection.hidden = false
}

function checkPinState() {
  if (document.hidden) return
  if (manualMode || !validExtensionId(extensionId) || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    showPinGuide()
    return
  }
  chrome.runtime.sendMessage(extensionId, { type: 'GET_PIN_STATE' }, response => {
    if (chrome.runtime.lastError || !response || typeof response.pinned !== 'boolean') {
      showPinGuide()
      return
    }
    if (response.pinned) {
      pinSection.hidden = true
      sessionStorage.removeItem('skip-pin')
    } else showPinGuide()
  })
}

skipButton.addEventListener('click', () => {
  sessionStorage.setItem('skip-pin', '1')
  pinSection.hidden = true
})

if (!manualMode) {
  checkPinState()
  timer = window.setInterval(checkPinState, 1500)
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) window.clearInterval(timer)
  else { checkPinState(); timer = window.setInterval(checkPinState, 1500) }
})
window.addEventListener('pagehide', () => window.clearInterval(timer))
