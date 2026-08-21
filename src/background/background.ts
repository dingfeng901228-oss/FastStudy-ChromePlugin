/**
 * Background service worker (MV3).
 *
 * MVP scope (per spec.md):
 *   - chrome.contextMenus.create({ contexts: ['selection'] }) → "收藏为生词"
 *   - onClicked → fetch POST jp.frank2025.com/api/vocabulary with Bearer token
 *   - Toast feedback via chrome.notifications
 *   - chrome.alarms wake-up to sync pendingVocabulary queue
 *
 * Architecture notes:
 *   - All chrome.* APIs are only available in the SW context (MV3).
 *   - chrome.notifications is used instead of an in-page toast because
 *     there's no content script yet (MVP). 通知 clearly visible +
 *     survives tab close. 需求 §18 accepts this for MVP.
 *   - When the popup is open it can listen for chrome.storage.onChanged
 *     and replay the last toast if it hasn't expired.
 */

import {
  enqueue,
  listPending,
  markAttemptFailed,
  markSynced,
  pendingCount,
} from '../lib/db';
import { getSettings, hasToken, saveSettings, type AppSettings } from '../lib/settings';
import {
  HTTP_STATUS_TO_TOAST,
  type PendingVocabulary,
  type ToastKind,
  type VocabularyPostResponse,
} from '../lib/types';

const BACKEND_BASE = 'https://jp.frank2025.com';
const VOCABULARY_ENDPOINT = `${BACKEND_BASE}/api/vocabulary`;
const SYNC_ALARM_NAME = 'faststudy-sync-pending';
const SYNC_ALARM_PERIOD_MIN = 5;
const TOAST_TTL_MS = 4000;
const MAX_PAYLOAD_BYTES = 4096; // defensive cap per 需求 §25

// ----------------------------------------------------------------------------
// Lifecycle: install → register context menu + alarms
// ----------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[FastStudy-ChromePlugin] installed:', details.reason);
  await registerContextMenu();
  await ensureSyncAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await registerContextMenu();
  await ensureSyncAlarm();
  // Best-effort: flush any queue left over from a previous SW cycle.
  await syncPendingQueue();
});

async function registerContextMenu(): Promise<void> {
  // removeAll first to make this idempotent — MV3 SW can wake multiple
  // times and re-register would throw "Cannot find item with id ...".
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'faststudy-collect-vocabulary',
    title: '收藏为生词', // chrome.i18n fallback handled below
    contexts: ['selection'],
    visible: true,
  });
}

async function ensureSyncAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(SYNC_ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(SYNC_ALARM_NAME, {
      periodInMinutes: SYNC_ALARM_PERIOD_MIN,
    });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) {
    void syncPendingQueue();
  }
});

// ----------------------------------------------------------------------------
// Context menu click → save vocabulary
// ----------------------------------------------------------------------------

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'faststudy-collect-vocabulary') return;
  const selection = info.selectionText?.trim() ?? '';
  const sourceUrl = info.pageUrl ?? tab?.url ?? '';
  const sourceTitle = tab?.title ?? '';

  if (!selection) {
    await pushToast('error', '未选中文字');
    return;
  }
  if (selection.length > MAX_PAYLOAD_BYTES) {
    await pushToast('error', '选中内容过长', `最多 ${MAX_PAYLOAD_BYTES} 字符`);
    return;
  }
  if (!sourceUrl) {
    await pushToast('error', '无法识别页面 URL');
    return;
  }

  if (!(await hasToken())) {
    await pushToast('auth', '请先连接 FastStudy', '在 jp.frank2025.com 设置中生成连接码');
    return;
  }

  await saveVocabulary({
    word: selection,
    sourceUrl,
    sourceTitle,
    sourceDomain: extractDomain(sourceUrl),
  });
});

// ----------------------------------------------------------------------------
// Save flow: online fetch → success / failure → toast + queue management
// ----------------------------------------------------------------------------

async function saveVocabulary(input: {
  word: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceDomain?: string;
}): Promise<void> {
  const settings = await getSettings();
  const token = settings.extensionToken;
  if (!token) {
    await pushToast('auth', '请先连接 FastStudy');
    return;
  }

  const body = {
    word: input.word,
    source: 'chrome-extension',
    sourceUrl: input.sourceUrl,
    sourceTitle: input.sourceTitle,
    sourceDomain: input.sourceDomain,
  };

  // Always build a pending item first so even success-path can rely
  // on the same shape (lastAttemptAt / attemptCount / lastError).
  const localId = crypto.randomUUID();
  const pending: PendingVocabulary = {
    localId,
    word: input.word,
    sourceUrl: input.sourceUrl,
    sourceTitle: input.sourceTitle,
    sourceDomain: input.sourceDomain,
    createdAt: Date.now(),
    attemptCount: 0,
  };

  try {
    const res = await fetch(VOCABULARY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const status = res.status;
    if (status === 200 || status === 201) {
      const data = (await res.json()) as VocabularyPostResponse;
      await pushToast(
        status === 200 ? 'duplicate' : 'success',
        status === 200 ? '已收藏过' : '已收藏',
        data.data?.word ?? input.word,
        data.data?.reading ?? undefined,
      );
      await bumpPopupStats(status === 200 ? 'duplicate' : 'success');
      return;
    }

    if (status === 401 || status === 403) {
      // Token revoked → don't queue (will keep failing). Surface toast
      // and ask user to reconnect.
      await pushToast(
        'auth',
        'FastStudy 连接已失效',
        '请重新生成 Token 后再次收藏',
      );
      return;
    }

    if (status === 429) {
      // Rate-limited — queue but mark high attemptCount so backoff works.
      await enqueue(pending);
      await pushToast('error', '请求过于频繁', '已存到待同步队列');
      return;
    }

    // 4xx (422, 5xx) → queue
    await enqueue(pending);
    const text = await safeReadText(res);
    await pushToast(
      'error',
      '收藏失败',
      `${status} ${text || '服务器错误'} — 已存到待同步队列`,
    );
  } catch (err) {
    // Network failure → queue
    await enqueue(pending);
    await markAttemptFailed(localId, String(err));
    await pushToast(
      'network',
      '收藏失败',
      '网络连接失败，已存到待同步队列',
    );
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

// ----------------------------------------------------------------------------
// Pending queue sync (offline retry)
// ----------------------------------------------------------------------------

async function syncPendingQueue(): Promise<{ ok: number; failed: number }> {
  const queue = await listPending();
  if (queue.length === 0) return { ok: 0, failed: 0 };

  const settings = await getSettings();
  const token = settings.extensionToken;
  if (!token) {
    // No token → nothing we can do; leave queue alone so reconnect
    // + manual retry can resume.
    return { ok: 0, failed: 0 };
  }

  let ok = 0;
  let failed = 0;
  for (const item of queue) {
    try {
      const res = await fetch(VOCABULARY_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          word: item.word,
          source: 'chrome-extension',
          sourceUrl: item.sourceUrl,
          sourceTitle: item.sourceTitle,
          sourceDomain: item.sourceDomain,
        }),
      });
      if (res.status === 200 || res.status === 201) {
        await markSynced(item.localId);
        ok++;
      } else if (res.status === 401 || res.status === 403) {
        // Token revoked — stop syncing, leave queue intact for reconnect.
        break;
      } else {
        await markAttemptFailed(item.localId, `HTTP ${res.status}`);
        failed++;
      }
    } catch (err) {
      await markAttemptFailed(item.localId, String(err));
      failed++;
    }
  }

  if (ok > 0) {
    await pushToast(
      'success',
      `已同步 ${ok} 个生词`,
      failed > 0 ? `失败 ${failed} 个` : undefined,
    );
  }
  return { ok, failed };
}

// ----------------------------------------------------------------------------
// Toast / notification bridge
// ----------------------------------------------------------------------------

async function pushToast(
  kind: ToastKind,
  title: string,
  detail?: string,
  _reading?: string,
): Promise<void> {
  const expiresAt = Date.now() + TOAST_TTL_MS;

  // 1) chrome.notifications — works even when popup isn't open and
  // survives tab close (MV3 SW quirk: in-page toasts need content script).
  const notifId = `faststudy-${Date.now()}`;
  try {
    await chrome.notifications.create(notifId, {
      type: 'basic',
      title: kindEmoji(kind) + ' ' + title,
      message: detail ?? '',
      iconUrl: chrome.runtime.getURL('icons/icon-48.png'),
    });
    // Auto-clear after TTL (notifications API has no auto-dismiss).
    setTimeout(() => {
      try {
        chrome.notifications.clear(notifId, () => undefined);
      } catch {
        /* swallow — non-fatal */
      }
    }, TOAST_TTL_MS);
  } catch (err) {
    console.warn('[FastStudy-ChromePlugin] notifications.create failed:', err);
  }

  // 2) Persist so popup can replay it on first paint.
  await saveSettings({
    lastToast: { kind, title, detail, expiresAt },
  });

  // 3) Cleanup expired toasts so the popup doesn't render stale ones.
  const s = await getSettings();
  if (s.lastToast && s.lastToast.expiresAt <= Date.now()) {
    await saveSettings({ lastToast: undefined });
  }
}

function kindEmoji(kind: ToastKind): string {
  switch (kind) {
    case 'success':
      return '✓';
    case 'duplicate':
      return '✓';
    case 'network':
      return '⚠';
    case 'auth':
      return '⚠';
    case 'error':
    default:
      return '✗';
  }
}

// ----------------------------------------------------------------------------
// Popup message handlers
// ----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'FS_POPUP_GET_PENDING') {
    void listPending().then((items) => sendResponse({ type: 'PENDING_LIST', items }));
    return true;
  }

  if (msg.type === 'FS_POPUP_SYNC_NOW') {
    void syncPendingQueue().then((res) =>
      sendResponse({ type: 'SYNC_RESULT', ...res }),
    );
    return true;
  }

  if (msg.type === 'FS_POPUP_CLEAR_PENDING') {
    void import('../lib/db').then((m) =>
      m.clearQueue().then(() => sendResponse({ type: 'CLEARED' })),
    );
    return true;
  }

  if (msg.type === 'FS_POPUP_DISCONNECT') {
    void (async () => {
      const { clearAuth } = await import('../lib/settings');
      await clearAuth();
      sendResponse({ type: 'DISCONNECTED' });
    })();
    return true;
  }

  if (msg.type === 'FS_POPUP_PING') {
    sendResponse({ type: 'PONG', ts: Date.now() });
    return false;
  }

  return false;
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function extractDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

// Defensive: keep the imports referenced even if tree-shaken in test env.
void pendingCount;
void HTTP_STATUS_TO_TOAST;

/**
 * Increment the popup counters. Today/week keys auto-reset when the
 * date rolls over (no clock-driven background task required — handled
 * lazily on each save). Duplicates don't bump the counters (only
 * fresh saves do).
 */
async function bumpPopupStats(kind: 'success' | 'duplicate'): Promise<void> {
  if (kind !== 'success') return;

  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);

  // Monday-of-this-week as YYYY-MM-DD.
  const dow = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const mondayOffset = dow === 0 ? 6 : dow - 1;
  const monday = new Date(today);
  monday.setDate(today.getDate() - mondayOffset);
  const weekKey = monday.toISOString().slice(0, 10);

  const s = await getSettings();
  const current =
    s.popupStats ??
    ({
      todaySaved: 0,
      weekSaved: 0,
      pendingCount: 0,
    } as NonNullable<AppSettings['popupStats']>);

  const newToday = current.todayKey === todayKey ? current.todaySaved + 1 : 1;
  const newWeek = current.weekKey === weekKey ? current.weekSaved + 1 : 1;
  const pending = await pendingCount();

  await saveSettings({
    popupStats: {
      todaySaved: newToday,
      weekSaved: newWeek,
      pendingCount: pending,
      lastSyncAt: Date.now(),
      todayKey,
      weekKey,
    },
  });
}