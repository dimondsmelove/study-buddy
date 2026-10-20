const params = new URLSearchParams(location.search)
const extensionId = params.get('id')
const pinSection = document.querySelector('#pin')
const skipButton = document.querySelector('#skip-pin')
let skippedPin = false
let timer

function validExtensionId(value) {
  return /^[a-p]{32}$/.test(value ?? '')
}

function showPinGuide() {
  if (!skippedPin) pinSection.hidden = false
}

function checkPinState() {
  if (document.hidden) return
  if (!validExtensionId(extensionId) || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
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
      skippedPin = false
    } else showPinGuide()
  })
}

skipButton.addEventListener('click', () => {
  skippedPin = true
  pinSection.hidden = true
})

function startPolling() {
  window.clearInterval(timer)
  if (document.hidden) return
  checkPinState()
  timer = window.setInterval(checkPinState, 1500)
}

const platform = navigator.userAgentData?.platform || navigator.platform
if (/Mac|iPhone|iPad/.test(platform)) document.querySelector('#capture-modifier').textContent = 'Cmd'
pinSection.hidden = false
startPolling()
document.addEventListener('visibilitychange', startPolling)
window.addEventListener('pageshow', startPolling)
window.addEventListener('pagehide', () => window.clearInterval(timer))
