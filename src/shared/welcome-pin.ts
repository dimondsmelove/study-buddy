export type ActionSettingsApi = {
  getUserSettings?: () => Promise<{ isOnToolbar?: unknown }>
}

export async function getPinnedState(action?: ActionSettingsApi): Promise<boolean | null> {
  try {
    const getUserSettings = action?.getUserSettings
    if (typeof getUserSettings !== 'function') return null
    const settings = await getUserSettings.call(action)
    return typeof settings?.isOnToolbar === 'boolean' ? settings.isOnToolbar : null
  } catch {
    return null
  }
}

export function createWelcomeInstallUrl(baseUrl: string, extensionId: string, pinned: boolean | null): string {
  const url = new URL(baseUrl)
  url.searchParams.set('id', extensionId)
  if (pinned !== null) url.searchParams.set('pinned', pinned ? '1' : '0')
  return url.href
}
