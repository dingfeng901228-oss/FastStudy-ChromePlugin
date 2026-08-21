/**
 * Shared types for FastStudy Chrome Plugin.
 *
 * MVP vocabulary source data (chrome-extension → jp.frank2025.com):
 *   - word: the selected text (Japanese headword/phrase)
 *   - source: "chrome-extension"
 *   - sourceUrl: page where the selection was made
 *   - sourceTitle: page title (optional)
 *
 * See spec.md §5 for the full data flow.
 */

/** Where this vocabulary_item came from. Server (vocabulary_items.source
 *  column) filters on this to count "browser-sourced" items. */
export type VocabularySource = 'chrome-extension' | 'manual' | 'import';

/** Pending offline-queue item — kept in chrome.storage.local until the
 *  fetch POST succeeds, then removed. */
export interface PendingVocabulary {
  /** Stable local id so retries dedupe correctly. */
  localId: string;
  word: string;
  sourceUrl: string;
  sourceTitle?: string;
  sourceDomain?: string;
  sourceFavicon?: string;
  /** ms epoch when the user right-clicked (NOT when synced). */
  createdAt: number;
  /** ms epoch of the last sync attempt (for backoff / debugging). */
  lastAttemptAt?: number;
  /** Number of failed attempts — exponential backoff trigger. */
  attemptCount: number;
  /** Last error message — surfaced in popup diagnostics. */
  lastError?: string;
}

/** Server response shape from POST /api/vocabulary. */
export type VocabularyPostResponse =
  | {
      success: true;
      duplicate: false;
      data: {
        id: string;
        word: string;
        reading: string | null;
        meaningZh: string;
      };
    }
  | {
      success: true;
      duplicate: true;
      message: string;
      data: {
        id: string;
        word: string;
        reading: string | null;
        meaningZh: string;
      };
    };

/** Error response from POST /api/vocabulary. */
export interface VocabularyPostError {
  success: false;
  error: string;
  code?: string;
}

/** Status of the extension's connection to jp.frank2025.com. */
export type ConnectionStatus =
  | { kind: 'unknown' }
  | { kind: 'connected'; tokenLabel: string | null; connectedAt: number }
  | { kind: 'disconnected' }
  | { kind: 'token_revoked' };

/** Toast feedback types — see spec §5 + 需求 §18. */
export type ToastKind = 'success' | 'duplicate' | 'error' | 'network' | 'auth';

export interface ToastMessage {
  kind: ToastKind;
  title: string;
  detail?: string;
  /** When this toast auto-dismisses (ms epoch). */
  expiresAt: number;
}

/** Backend API status code → toast mapping (per 需求 §26). */
export const HTTP_STATUS_TO_TOAST: Record<number, ToastKind> = {
  200: 'duplicate',
  201: 'success',
  401: 'auth',
  403: 'auth',
  422: 'error',
  429: 'error',
  500: 'error',
  502: 'error',
  503: 'error',
};