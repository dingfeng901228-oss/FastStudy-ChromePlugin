/**
 * SM-2 simplified spaced-repetition algorithm.
 *
 * Reference: Piotr Wozniak, "Optimization of repetition spacing in the
 * practice of learning" (1990). The original SM-2 takes a 0–5 quality grade
 * per review; we collapse that into four discrete grades that map cleanly
 * onto FastStudy's existing UX:
 *
 *   again (quality ≈ 1): user got it wrong → reset interval, drop ease
 *   hard  (quality ≈ 3): got it with effort → keep interval, small ease drop
 *   good  (quality ≈ 4): normal review pass → multiply by ease
 *   easy  (quality ≈ 5): shortcut to mastered → bigger jump, bump ease
 *
 * State carried on each word:
 *   intervalDays : current scheduled gap (rounded to whole days)
 *   ease         : SM-2 ease factor, initial 2.5, clamped to [1.3, 3.0]
 *   reviewCount  : number of completed reviews (used for analytics)
 *
 * Usage:
 *   const { state, nextReviewAt } = applyGrade(prev, 'good');
 *   // persist state + nextReviewAt on the Word record
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_EASE = 1.3;
const MAX_EASE = 3.0;
const EASY_FIRST_INTERVAL_DAYS = 4;

export type SrsGrade = 'again' | 'hard' | 'good' | 'easy';

export interface SrsState {
  intervalDays: number;
  ease: number;
  reviewCount: number;
}

export interface SrsResult {
  state: SrsState;
  nextReviewAt: number;
}

export const INITIAL_SRS: SrsState = {
  intervalDays: 0,
  ease: 2.5,
  reviewCount: 0,
};

export function applyGrade(
  prev: SrsState,
  grade: SrsGrade,
  now: number = Date.now(),
): SrsResult {
  let ease: number;
  let intervalDays: number;

  switch (grade) {
    case 'again':
      ease = Math.max(MIN_EASE, prev.ease - 0.2);
      intervalDays = 1;
      break;
    case 'hard':
      // Keep the current interval but apply a small ease penalty so the
      // next review interval doesn't grow as fast as 'good' would.
      ease = Math.max(MIN_EASE, prev.ease - 0.15);
      intervalDays =
        prev.intervalDays === 0 ? 1 : prev.intervalDays;
      break;
    case 'good':
      ease = prev.ease;
      intervalDays =
        prev.intervalDays === 0 ? 1 : Math.round(prev.intervalDays * ease);
      break;
    case 'easy':
    default:
      ease = Math.min(MAX_EASE, prev.ease + 0.15);
      intervalDays =
        prev.intervalDays === 0
          ? EASY_FIRST_INTERVAL_DAYS
          : Math.round(prev.intervalDays * ease * 1.3);
      break;
  }

  return {
    state: {
      intervalDays,
      ease: Math.round(ease * 1000) / 1000, // trim float noise
      reviewCount: prev.reviewCount + 1,
    },
    nextReviewAt: now + intervalDays * DAY_MS,
  };
}

/** Map the FastStudy binary status (set on save) to an SM-2 grade. */
export function gradeForStatus(status: 'learning' | 'mastered'): SrsGrade {
  return status === 'mastered' ? 'easy' : 'good';
}

/** Hydrate an SrsState from a Word row (handles missing fields on legacy data). */
export function srsStateFromWord(word: {
  intervalDays?: number;
  ease?: number;
  reviewCount: number;
}): SrsState {
  return {
    intervalDays: word.intervalDays ?? 0,
    ease: word.ease ?? 2.5,
    reviewCount: word.reviewCount,
  };
}