/**
 * Extension settings storage via chrome.storage.local.
 *
 * MVP stores:
 *   - extensionToken: Bearer token issued by jp.frank2025.com
 *     Settings → Browser Extension page (see 需求 §15-§16).
 *   - tokenLabel: free-form label like "Chrome / Windows" — surfaces
 *     in the user's Settings page so they can identify which device
 *     the token belongs to (需求 §16).
 *   - connectedAt: ms epoch when the token was first connected.
 *   - popupStats: cached counts shown on the popup (todaySaved /
 *     weekSaved). Refreshed when the popup opens and on
 *     chrome.storage.onChanged events.
 */

export interface AppSettings {
  extensionToken?: string;
  tokenLabel?: string;
  connectedAt?: number;
  popupStats?: {
    todaySaved: number;
    weekSaved: number;
    pendingCount: number;
    lastSyncAt?: number;
    /** YYYY-MM-DD; bump resets todaySaved to 1 if mismatched. */
    todayKey?: string;
    /** YYYY-MM-DD of the Monday that starts the current week. */
    weekKey?: string;
  };
  // Last toast the service worker pushed — lets the popup replay it
  // on first paint without waiting for chrome.storage.onChanged.
  lastToast?: {
    kind: 'success' | 'duplicate' | 'error' | 'network' | 'auth';
    title: string;
    detail?: string;
    expiresAt: number;
  };
}

const DEFAULTS: AppSettings = {};

const SETTINGS_KEYS = [
  'extensionToken',
  'tokenLabel',
  'connectedAt',
  'popupStats',
  'lastToast',
] as const;

export async function getSettings(): Promise<AppSettings> {
  const data = await chrome.storage.local.get([...SETTINGS_KEYS]);
  return {
    extensionToken:
      typeof data.extensionToken === 'string' && data.extensionToken.length > 0
        ? data.extensionToken
        : undefined,
    tokenLabel:
      typeof data.tokenLabel === 'string' && data.tokenLabel.length > 0
        ? data.tokenLabel
        : undefined,
    connectedAt:
      typeof data.connectedAt === 'number' ? data.connectedAt : undefined,
    popupStats:
      typeof data.popupStats === 'object' && data.popupStats !== null
        ? (data.popupStats as AppSettings['popupStats'])
        : undefined,
    lastToast:
      typeof data.lastToast === 'object' && data.lastToast !== null
        ? (data.lastToast as AppSettings['lastToast'])
        : undefined,
  };
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set(patch);
  return next;
}

/** Convenience: clear token-related fields (for "解除连接" / revoke flows). */
export async function clearAuth(): Promise<void> {
  await chrome.storage.local.remove(['extensionToken', 'tokenLabel', 'connectedAt']);
}

export async function hasToken(): Promise<boolean> {
  const s = await getSettings();
  return typeof s.extensionToken === 'string' && s.extensionToken.length > 0;
}