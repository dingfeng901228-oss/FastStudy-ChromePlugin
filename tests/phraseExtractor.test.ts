import { describe, it, expect } from 'vitest';
import { extractPhrases } from '../src/lib/phraseExtractor';

describe('extractPhrases', () => {
  describe('edge cases', () => {
    it('returns empty array for empty string', () => {
      expect(extractPhrases('')).toEqual([]);
    });

    it('returns empty array for pure punctuation / whitespace', () => {
      expect(extractPhrases('   ... !!')).toEqual([]);
    });

    it('returns empty array for non-ASCII (Japanese / Chinese) text', () => {
      expect(extractPhrases('こんにちは')).toEqual([]);
      expect(extractPhrases('你好世界')).toEqual([]);
    });

    it('skips single-character tokens', () => {
      const r = extractPhrases('a I x y world');
      const words = r.filter((p) => p.kind === 'word').map((w) => w.text);
      expect(words).not.toContain('x');
      expect(words).not.toContain('y');
      expect(words).toContain('world');
    });
  });

  describe('single-word extraction', () => {
    it('extracts only content words', () => {
      const r = extractPhrases('She bought apples');
      const words = r.filter((p) => p.kind === 'word').map((w) => w.text);
      expect(words).toEqual(['bought', 'apples']);
    });

    it('skips stopwords but keeps content verbs like "need"', () => {
      const r = extractPhrases('I need to go now');
      const words = r.filter((p) => p.kind === 'word').map((w) => w.text);
      // 'I', 'to', 'now' are stopwords; 'need' and 'go' are content (verbs)
      expect(words).toEqual(['need', 'go']);
      expect(words).not.toContain('i');
      expect(words).not.toContain('to');
      expect(words).not.toContain('now');
    });

    it('normalizes to lowercase', () => {
      const r = extractPhrases('The QUICK Brown Fox');
      const words = r.filter((p) => p.kind === 'word').map((w) => w.text);
      expect(words).toEqual(['quick', 'brown', 'fox']);
    });

    it('handles contractions as single tokens', () => {
      const r = extractPhrases("I'm reading a book");
      const words = r.filter((p) => p.kind === 'word').map((w) => w.text);
      // "i'm" is not in stoplist, treated as content
      expect(words).toContain("i'm");
    });
  });

  describe('phrase extraction', () => {
    it('extracts "break the ice" as a phrase including the stopword', () => {
      const r = extractPhrases('I need to break the ice');
      const phrases = r.filter((p) => p.kind === 'phrase').map((p) => p.text);
      expect(phrases).toContain('break the ice');
    });

    it('extracts "new colleagues" as a phrase (drops possessive "my")', () => {
      // "my" is in the stoplist so the 3-content-word run can't form;
      // the meaningful phrase is just "new colleagues".
      const r = extractPhrases('These are my new colleagues');
      const phrases = r.filter((p) => p.kind === 'phrase').map((p) => p.text);
      expect(phrases).toContain('new colleagues');
    });

    it('extracts "bought apples" as a phrase', () => {
      const r = extractPhrases('She bought apples at the store');
      const phrases = r.filter((p) => p.kind === 'phrase').map((p) => p.text);
      expect(phrases).toContain('bought apples');
    });

    it('does not form phrases with >1 stopword gap between content words', () => {
      // "I really want to actually go now"
      // content words: really, want, go
      // gaps: [0 (really→want adjacent), 2 (want→go via "to actually")]
      // 2-grams: [really, want] gap=0 ok → "really want"
      //          [want, go]    gap=2 fail
      // 3-grams: [really, want, go] gapAfter[1]=2 fail
      const r = extractPhrases('I really want to actually go now');
      const phrases = r.filter((p) => p.kind === 'phrase').map((p) => p.text);
      expect(phrases).toContain('really want');
      expect(phrases).not.toContain('want go');
      expect(phrases).not.toContain('really want to actually go');
    });

    it('extracts 3-content-word phrases including idioms', () => {
      const r = extractPhrases('I love the good old days');
      // content: love, good, old, days
      // 3-grams of consecutive content:
      //   [love, good, old] gapAfter=[1,0] max=1 → "love the good old"
      //   [good, old, days] gapAfter=[0,0] max=0 → "good old days"
      const phrases = r.filter((p) => p.kind === 'phrase').map((p) => p.text);
      expect(phrases).toContain('good old days');
      expect(phrases).toContain('love the good old');
    });

    it('preserves original case for surface form', () => {
      const r = extractPhrases('The QUICK Brown Fox jumps');
      // 3-gram [QUICK, Brown, Fox] no stopword gap → "QUICK Brown Fox" / "quick brown fox"
      const phrase = r.find((p) => p.kind === 'phrase' && p.text === 'quick brown fox');
      expect(phrase?.original).toBe('QUICK Brown Fox');
    });
  });

  describe('position tracking', () => {
    it('tracks start/end positions correctly for single words', () => {
      const r = extractPhrases('hi there world');
      const world = r.find((p) => p.text === 'world');
      expect(world).toBeDefined();
      // 'hi'(0-1) + ' ' + 'there'(3-7) + ' ' + 'world'(9-13)
      expect(world!.start).toBe(9);
      expect(world!.end).toBe(14);
    });

    it('tracks phrase span including stopwords between content words', () => {
      const text = 'break the ice';
      const r = extractPhrases(text);
      const phrase = r.find((p) => p.kind === 'phrase');
      expect(phrase).toBeDefined();
      expect(text.slice(phrase!.start, phrase!.end)).toBe('break the ice');
    });
  });
});
