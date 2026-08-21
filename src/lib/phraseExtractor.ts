/**
 * Phrase extractor for YouTube subtitle lines.
 *
 * Identifies saveable single words and short phrases (2–3 consecutive content
 * words). Output items carry start/end positions in the source string so the
 * content script can wrap them in clickable spans. The renderer should apply
 * longest-match-wins to handle overlap (single words inside a multi-word
 * phrase should not be wrapped separately).
 *
 * Tokenization:
 *   - locale=undefined or 'en' → ASCII letter regex (English-only MVP)
 *   - locale='ja' | 'zh-CN' | 'zh-Hant' | 'ko' | ... → Intl.Segmenter
 *     (segmenter-based word splitting, supports CJK / Latin / Thai / Arabic)
 *
 * Stopword filtering:
 *   - English (and default) → applies the English stoplist + length ≥ 2
 *   - Other locales (MVP) → no stoplist; all segmenter tokens count as content.
 *     Future versions can add per-language stopword tables.
 *
 * Existing callers that pass no locale (or 'en') keep the original English-only
 * behaviour, so the v0.1 test suite continues to pass.
 */

export type PhraseKind = 'word' | 'phrase';

export interface ExtractedPhrase {
  /** Normalized lowercase form used for storage and dedup. */
  text: string;
  /** Original case as it appears in the subtitle, used for display. */
  original: string;
  /** 'word' for a single token; 'phrase' for a multi-token span. */
  kind: PhraseKind;
  /** Inclusive start char index in the source text. */
  start: number;
  /** Exclusive end char index in the source text. */
  end: number;
}

/**
 * English function-word stoplist. Used to identify "content" tokens that are
 * worth saving. Multi-word phrases may include stopwords internally (e.g.
 * "break the ice"); the stoplist only filters which individual words become
 * saveable on their own.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // articles / demonstratives
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  // personal / possessive pronouns
  'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their',
  'mine', 'yours', 'hers', 'ours', 'theirs',
  // be-verbs
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  // common auxiliaries
  'have', 'has', 'had', 'having',
  'do', 'does', 'did', 'doing', 'done',
  'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must',
  // common prepositions
  'in', 'on', 'at', 'by', 'for', 'with', 'about',
  'as', 'into', 'through', 'to', 'from', 'of',
  'up', 'down', 'out', 'over', 'under',
  'again', 'further', 'once', 'off',
  // conjunctions
  'and', 'or', 'but', 'if', 'while', 'because', 'so', 'than',
  // common adverbs
  'not', 'no', 'only', 'very', 'just', 'also', 'now', 'then',
  'here', 'there', 'when', 'where', 'why', 'how',
  // interrogatives / determiners
  'what', 'which', 'who', 'whom', 'all', 'any', 'both', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'own', 'same',
]);

const WORD_TOKEN = /[A-Za-z][A-Za-z']*/g;

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(text: string, locale?: string): Token[] {
  // Opt-in path: explicit non-English locale → Intl.Segmenter.
  // Skipped for 'en' / undefined so the legacy ASCII regex stays the
  // single source of truth for English tokenization (preserves v0.1 tests).
  if (locale && locale !== 'en') {
    try {
      const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
      const tokens: Token[] = [];
      for (const s of segmenter.segment(text)) {
        // isWordLike is true | false | undefined; treat anything other than
        // explicitly false as a word (segments without the flag are still
        // usually word-like for our purposes).
        if (s.isWordLike !== false) {
          tokens.push({
            text: s.segment,
            start: s.index,
            end: s.index + s.segment.length,
          });
        }
      }
      if (tokens.length > 0) return tokens;
      // Empty result (e.g. pure punctuation) → fall through to ASCII fallback
      // so the existing length / stopword pipeline still runs.
    } catch {
      // Intl.Segmenter unavailable or unsupported locale — fall through.
    }
  }

  const tokens: Token[] = [];
  WORD_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_TOKEN.exec(text)) !== null) {
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

function isContent(token: string, locale?: string): boolean {
  const t = token.toLowerCase();
  if (t.length < 2) return false; // skip 1-char tokens like "I", "x"
  // English path applies the stoplist; non-English MVP path treats all
  // segmenter tokens as content (no language-specific stoplist yet).
  if (locale && locale !== 'en') return true;
  return !STOPWORDS.has(t);
}

/**
 * Extract saveable items from a subtitle line.
 *
 * Heuristic:
 *   1. Tokenize into ASCII letter runs (apostrophes allowed inside).
 *   2. Identify content tokens (length ≥ 2, not in stoplist).
 *   3. Each content token becomes a single-word candidate.
 *   4. Consecutive content tokens form 2- or 3-content-word phrases. The
 *      original text span (including any stopwords between them) becomes the
 *      phrase surface form. We allow at most 1 stopword gap between any
 *      adjacent pair, so "I really want to actually go" yields no phrases
 *      while "I need to break the ice" yields "break the ice".
 *
 * Returns phrases sorted by start position; overlaps are possible and the
 * renderer must apply longest-match-wins.
 */
export function extractPhrases(text: string, locale?: string): ExtractedPhrase[] {
  const tokens = tokenize(text, locale);
  if (tokens.length === 0) return [];

  // Walk tokens; record indices of content tokens and how many non-content
  // tokens sit between each pair.
  const contentIdx: number[] = [];
  const gapAfter: number[] = []; // gapAfter[i] = stopwords between content i-1 and content i
  let pending = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (isContent(tokens[i].text, locale)) {
      contentIdx.push(i);
      if (contentIdx.length > 1) {
        gapAfter.push(pending);
      }
      pending = 0;
    } else {
      pending++;
    }
  }
  if (contentIdx.length === 0) return [];

  const out: ExtractedPhrase[] = [];

  // Single content words
  for (const tokIdx of contentIdx) {
    const t = tokens[tokIdx];
    out.push({
      text: t.text.toLowerCase(),
      original: t.text,
      kind: 'word',
      start: t.start,
      end: t.end,
    });
  }

  // Phrases: runs of n consecutive content tokens (n = 2 or 3) with each
  // adjacent gap ≤ 1 stopword. This filters noise like "I need to go" (two
  // stopword gaps) while keeping idioms like "break the ice" (one stopword).
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= contentIdx.length; i++) {
      let ok = true;
      for (let j = i + 1; j < i + n; j++) {
        if (gapAfter[j - 1] > 1) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      const firstTokIdx = contentIdx[i];
      const lastTokIdx = contentIdx[i + n - 1];
      const firstTok = tokens[firstTokIdx];
      const lastTok = tokens[lastTokIdx];
      const surface = text.slice(firstTok.start, lastTok.end);
      const normalized = tokens
        .slice(firstTokIdx, lastTokIdx + 1)
        .map((t) => t.text.toLowerCase())
        .join(' ');

      out.push({
        text: normalized,
        original: surface,
        kind: 'phrase',
        start: firstTok.start,
        end: lastTok.end,
      });
    }
  }

  return out;
}
