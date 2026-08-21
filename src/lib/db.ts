/**
 * chrome.storage.local wrapper + pendingVocabulary offline queue.
 *
 * No IndexedDB — the extension has minimal data needs (token, settings,
 * offline queue). chrome.storage.local is simpler, synchronous-ish, and
 * survives extension restarts.
 *
 * Pending queue semantics (per 需求 §19 + spec.md §5):
 *   - Network failure / 5xx / network offline → enqueue
 *   - 200 / 201 success → never enqueued (returned immediately)
 *   - 401 / 403 token revoked → enqueue still? NO — surface "重新连接"
 *     toast and don't pollute the queue with doomed requests.
 *   - background service worker wakes via chrome.alarms every 5 min
 *     and retries the queue head (FIFO), removing on success.
 */

import type { PendingVocabulary } from './types';

const STORAGE_KEY = 'pendingVocabulary';

async function readQueue(): Promise<PendingVocabulary[]> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const raw = data[STORAGE_KEY];
  return Array.isArray(raw) ? (raw as PendingVocabulary[]) : [];
}

async function writeQueue(items: PendingVocabulary[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
}

export async function listPending(): Promise<PendingVocabulary[]> {
  return readQueue();
}

export async function pendingCount(): Promise<number> {
  return (await readQueue()).length;
}

export async function enqueue(item: PendingVocabulary): Promise<void> {
  const queue = await readQueue();
  queue.push(item);
  await writeQueue(queue);
}

/** Remove a successfully-synced item from the queue. */
export async function markSynced(localId: string): Promise<void> {
  const queue = await readQueue();
  const next = queue.filter((it) => it.localId !== localId);
  if (next.length !== queue.length) {
    await writeQueue(next);
  }
}

/** Record a failed sync attempt — increment attemptCount + set lastError. */
export async function markAttemptFailed(
  localId: string,
  errMsg: string,
): Promise<void> {
  const queue = await readQueue();
  const next = queue.map((it) =>
    it.localId === localId
      ? {
          ...it,
          attemptCount: it.attemptCount + 1,
          lastAttemptAt: Date.now(),
          lastError: errMsg,
        }
      : it,
  );
  await writeQueue(next);
}

/** Drop items that have failed too many times (>10 attempts) — avoid
 *  infinite-loop poison messages in the queue. */
export async function dropPoisoned(maxAttempts = 10): Promise<number> {
  const queue = await readQueue();
  const keep = queue.filter((it) => it.attemptCount < maxAttempts);
  if (keep.length !== queue.length) {
    await writeQueue(keep);
  }
  return queue.length - keep.length;
}

/** Used by tests + dev tools. Not used in production. */
export async function clearQueue(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}