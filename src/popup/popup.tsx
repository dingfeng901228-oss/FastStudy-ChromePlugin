import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BookOpen, Clock, AlertCircle, ExternalLink, RefreshCw, Unplug } from 'lucide-react';
import { getSettings } from '../lib/settings';
import { listPending } from '../lib/db';
import type { PendingVocabulary } from '../lib/types';

const BACKEND_BASE = 'https://jp.frank2025.com';
const REDEEM_ENDPOINT = `${BACKEND_BASE}/api/extension/redeem`;
const SETTINGS_URL = `${BACKEND_BASE}/settings/browser-extension`;

/** Strip non-alphanumeric, lowercase, insert hyphen after 4 chars.
 *  Handles raw paste (e.g. "p6e8byda" or "P6E8-BYDA") → "p6e8-byda". */
function formatCodeInput(s: string): string {
  const clean = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (clean.length <= 4) return clean;
  return clean.slice(0, 4) + '-' + clean.slice(4, 8);
}

function isValidCode(s: string): boolean {
  return /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(s);
}

type View = 'home' | 'settings';

interface PopupState {
  connected: boolean;
  tokenLabel: string | null;
  connectedAt: number | null;
  todaySaved: number;
  weekSaved: number;
  pendingCount: number;
  pendingItems: PendingVocabulary[];
  lastSyncAt: number | null;
  lastToast: {
    kind: 'success' | 'duplicate' | 'error' | 'network' | 'auth';
    title: string;
    detail?: string;
    expiresAt: number;
  } | null;
}

const EMPTY_STATE: PopupState = {
  connected: false,
  tokenLabel: null,
  connectedAt: null,
  todaySaved: 0,
  weekSaved: 0,
  pendingCount: 0,
  pendingItems: [],
  lastSyncAt: null,
  lastToast: null,
};

function t(key: string): string {
  try {
    const msg = chrome.i18n.getMessage(key);
    return msg && msg.length > 0 ? msg : key;
  } catch {
    return key;
  }
}

const Popup: React.FC = () => {
  const [view, setView] = useState<View>('home');
  const [state, setState] = useState<PopupState>(EMPTY_STATE);
  const [busy, setBusy] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);

  // Initial load + react to storage changes (toasts + queue updates).
  useEffect(() => {
    const load = async () => {
      const [s, pending] = await Promise.all([getSettings(), listPending()]);
      const stillFresh =
        s.lastToast && s.lastToast.expiresAt > Date.now() ? s.lastToast : null;
      setState({
        connected:
          typeof s.extensionToken === 'string' && s.extensionToken.length > 0,
        tokenLabel: s.tokenLabel ?? null,
        connectedAt: s.connectedAt ?? null,
        todaySaved: s.popupStats?.todaySaved ?? 0,
        weekSaved: s.popupStats?.weekSaved ?? 0,
        pendingCount: pending.length,
        pendingItems: pending,
        lastSyncAt: s.popupStats?.lastSyncAt ?? null,
        lastToast: stillFresh,
      });
    };
    void load();

    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      _area: string,
    ) => {
      if (changes.lastToast) {
        const v = changes.lastToast.newValue as PopupState['lastToast'];
        const fresh =
          v && typeof v.expiresAt === 'number' && v.expiresAt > Date.now()
            ? v
            : null;
        setState((prev) => ({ ...prev, lastToast: fresh }));
      }
      if (changes.popupStats) {
        const v = changes.popupStats.newValue as PopupState['todaySaved'] extends number
          ? PopupState
          : never;
        // Conservative: re-fetch everything rather than guessing the shape.
        void load();
      }
      if (changes.extensionToken || changes.tokenLabel || changes.connectedAt) {
        void load();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const handleConnectClick = () => {
    chrome.tabs.create({ url: SETTINGS_URL });
  };

  const handleConnect = async () => {
    const code = codeInput.trim();
    if (!isValidCode(code)) {
      setConnectError(t('connectInvalidCode') || '连接码格式错误（应为 XXXX-XXXX）');
      return;
    }
    setBusy(true);
    setConnectError(null);
    try {
      const res = await fetch(REDEEM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok || !data.success || !data.token) {
        // Map known error codes to user-friendly messages.
        const code = data?.error ?? '';
        const friendly =
          code === 'expired_code'
            ? '连接码已过期（10分钟），请回到 Settings 重新生成'
            : code === 'already_consumed'
            ? '连接码已使用过，请回到 Settings 重新生成'
            : code === 'invalid_code'
            ? '连接码无效，请检查后重试'
            : `连接失败：${code || res.status}`;
        setConnectError(friendly);
        return;
      }
      // Save token + label + connectedAt. The chrome.storage.onChanged
      // listener at the top picks this up and re-renders the popup.
      await chrome.storage.local.set({
        extensionToken: data.token,
        tokenLabel: data.label ?? null,
        connectedAt: Date.now(),
      });
      setCodeInput('');
    } catch (err) {
      setConnectError(`连接失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSyncNow = async () => {
    setBusy(true);
    try {
      await chrome.runtime.sendMessage({ type: 'FS_POPUP_SYNC_NOW' });
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      await chrome.runtime.sendMessage({ type: 'FS_POPUP_DISCONNECT' });
    } finally {
      setBusy(false);
    }
  };

  const handleClearPending = async () => {
    if (
      !confirm(
        t('confirmClearPending') ||
          'Clear all pending items? They will NOT be re-synced.',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await chrome.runtime.sendMessage({ type: 'FS_POPUP_CLEAR_PENDING' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="popup">
      <header className="popup-header">
        <h1>
          <BookOpen size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          {t('appName')}
        </h1>
        <span className="version">v1.0.0</span>
      </header>

      {state.lastToast && (
        <div className={`toast toast-${state.lastToast.kind}`} role="status">
          <strong>{state.lastToast.title}</strong>
          {state.lastToast.detail && <div className="toast-detail">{state.lastToast.detail}</div>}
        </div>
      )}

      {view === 'home' ? (
        <main className="popup-main">
          {/* Connection status */}
          <section className="card">
            <div className="status-row">
              <span
                className={`status-dot status-dot-${
                  state.connected ? 'on' : 'off'
                }`}
                aria-hidden="true"
              />
              <span className="status-label">
                {state.connected
                  ? t('connected') || '已连接'
                  : t('disconnected') || '尚未连接'}
              </span>
              {state.connected && (
                <button
                  className="btn-link"
                  onClick={() => setView('settings')}
                >
                  {t('settings') || '设置'}
                </button>
              )}
            </div>
            {state.connected && state.tokenLabel && (
              <div className="status-meta">
                {t('device') || '设备'}: <code>{state.tokenLabel}</code>
                {state.connectedAt && (
                  <>
                    {' · '}
                    {t('connectedAt') || '连接于'}:{' '}
                    {formatDate(state.connectedAt)}
                  </>
                )}
              </div>
            )}
          </section>

          {!state.connected ? (
            <section className="card card-cta">
              <p className="cta-text">
                {t('connectPrompt') ||
                  '将收藏的日语单词同步到 FastStudy。'}
              </p>
              <p className="cta-help">
                {t('connectHelp') ||
                  '在 jp.frank2025.com 设置中生成连接码，粘贴到这里。'}
              </p>
              <input
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                value={codeInput}
                onChange={(e) => {
                  setCodeInput(formatCodeInput(e.target.value));
                  setConnectError(null);
                }}
                placeholder={t('connectInputPlaceholder') || 'XXXX-XXXX'}
                maxLength={9}
                className="code-input"
                aria-label={t('connectInputPlaceholder') || 'XXXX-XXXX'}
              />
              {connectError && (
                <div className="connect-error" role="alert">
                  ✗ {connectError}
                </div>
              )}
              <button
                className="btn-primary btn-block"
                onClick={handleConnect}
                disabled={busy || !isValidCode(codeInput)}
              >
                {busy
                  ? (t('connecting') || '连接中…')
                  : (t('connect') || '连接')}
              </button>
              <button
                className="btn-link"
                onClick={handleConnectClick}
                style={{ marginTop: 8, display: 'block', textAlign: 'center' }}
              >
                {t('connectGetCode') || '没有连接码？去 Settings 生成 →'}
              </button>
            </section>
          ) : (
            <>
              {/* Stats */}
              <section className="stats-grid">
                <div className="stat-card">
                  <div className="stat-label">
                    {t('todaySaved') || '今日收藏'}
                  </div>
                  <div className="stat-value">{state.todaySaved}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">
                    {t('weekSaved') || '本周收藏'}
                  </div>
                  <div className="stat-value">{state.weekSaved}</div>
                </div>
              </section>

              {/* Pending queue */}
              {state.pendingCount > 0 && (
                <section className="card card-warn">
                  <div className="status-row">
                    <Clock size={14} />
                    <span>
                      {t('pending') || '待同步'}: <strong>{state.pendingCount}</strong>
                    </span>
                    <button
                      className="btn-link"
                      onClick={handleSyncNow}
                      disabled={busy}
                    >
                      <RefreshCw
                        size={11}
                        style={{ verticalAlign: '-1px', marginRight: 2 }}
                      />
                      {t('syncNow') || '立即同步'}
                    </button>
                  </div>
                  {state.pendingItems.slice(0, 3).map((p) => (
                    <div className="pending-row" key={p.localId}>
                      <span className="pending-word">{p.word}</span>
                      {p.attemptCount > 0 && (
                        <span className="pending-attempts">
                          {t('attempts') || '尝试'}: {p.attemptCount}
                        </span>
                      )}
                    </div>
                  ))}
                  {state.pendingItems.length > 3 && (
                    <div className="pending-more">
                      +{state.pendingItems.length - 3}{' '}
                      {t('more') || '更多'}
                    </div>
                  )}
                </section>
              )}

              {/* Jump to vocab */}
              <section className="card">
                <button
                  className="btn-primary btn-block"
                  onClick={() =>
                    chrome.tabs.create({
                      url: 'https://jp.frank2025.com/vocabulary',
                    })
                  }
                >
                  <ExternalLink
                    size={13}
                    style={{ verticalAlign: '-1px', marginRight: 4 }}
                  />
                  {t('openVocab') || '打开我的词汇库'}
                </button>
              </section>
            </>
          )}

          <footer className="popup-footer">
            <button className="btn-link" onClick={() => setView('settings')}>
              {t('settings') || '设置'}
            </button>
          </footer>
        </main>
      ) : (
        <main className="popup-main">
          <section className="card">
            <button
              className="btn-link"
              onClick={() => setView('home')}
              style={{ marginBottom: 8 }}
            >
              ← {t('back') || '返回'}
            </button>

            <h2 className="settings-title">
              {t('settingsTitle') || '设置'}
            </h2>

            <div className="settings-row">
              <span>{t('device') || '设备'}</span>
              <code>{state.tokenLabel ?? '—'}</code>
            </div>
            <div className="settings-row">
              <span>{t('connectedAt') || '连接于'}</span>
              <code>
                {state.connectedAt ? formatDate(state.connectedAt) : '—'}
              </code>
            </div>
            <div className="settings-row">
              <span>{t('lastSync') || '最后同步'}</span>
              <code>
                {state.lastSyncAt ? formatDate(state.lastSyncAt) : '—'}
              </code>
            </div>

            <div className="settings-actions">
              <button
                className="btn-secondary"
                onClick={handleSyncNow}
                disabled={busy}
              >
                <RefreshCw
                  size={12}
                  style={{ verticalAlign: '-1px', marginRight: 4 }}
                />
                {t('syncNow') || '立即同步'}
              </button>

              {state.pendingCount > 0 && (
                <button
                  className="btn-warn"
                  onClick={handleClearPending}
                  disabled={busy}
                >
                  <AlertCircle
                    size={12}
                    style={{ verticalAlign: '-1px', marginRight: 4 }}
                  />
                  {t('clearPending') || '清空待同步'}
                </button>
              )}

              <button
                className="btn-danger"
                onClick={handleDisconnect}
                disabled={busy}
              >
                <Unplug
                  size={12}
                  style={{ verticalAlign: '-1px', marginRight: 4 }}
                />
                {t('disconnect') || '解除连接'}
              </button>
            </div>

            <p className="settings-help">
              {t('reconnectHint') ||
                '解除连接后，请在 jp.frank2025.com/settings/browser-extension 重新生成连接码。'}
            </p>
          </section>

          <footer className="popup-footer">
            Storage: <code>chrome.storage.local</code>
            <br />
            Endpoint: <code>jp.frank2025.com/api/vocabulary</code>
          </footer>
        </main>
      )}
    </div>
  );
};

function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);