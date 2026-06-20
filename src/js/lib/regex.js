// @ts-check
//! Safe compilation of user-supplied regular expressions.
//!
//! JS's RegExp engine is backtracking, so "evil" patterns like (a+)+$ give
//! exponential time on bad input on the MAIN thread (ReDoS): the UI freezes
//! solid. A synchronous .test() cannot be interrupted on the same thread, so
//! the protection here is PREVENTIVE — we reject the dangerous ones BEFORE
//! running:
//!   1) limit the pattern length;
//!   2) cut out giant {n,m} repeats;
//!   3) heuristically reject nested unbounded quantifiers
//!      ((a+)+, (.*)* etc. — the classic cause of catastrophic backtracking).
//!
//! This is not bulletproof (see the note at the end), but it handles the typical
//! cases. Any rejected pattern = silent degradation to substring search, not a
//! failure: the caller always gets a working matcher.

/** Maximum pattern length. Longer → straight to the fallback. */
export const MAX_PATTERN_LENGTH = 200;

/** Upper bound for the counter in {n}, {n,}, {n,m}. Larger → fallback. */
export const MAX_REPEAT = 1000;

/**
 * Catastrophic-backtracking heuristic: does the pattern contain a group
 * quantified unboundedly (`*`, `+`, `{…`) whose body itself contains a
 * quantifier — at any nesting depth. That is (a+)+, (.*)* , ((a+))+ …
 *
 * Correctly ignores escaped parentheses (`\(`) and the contents of `[…]`
 * classes, where `(`, `+`, `*` are literals. Alternation by itself is NOT
 * treated as dangerous ((a|b)* is linear), to avoid false rejections.
 *
 * @param {string} src
 * @returns {boolean}
 */
export function hasNestedQuantifier(src) {
  /** @type {boolean[]} stack: for each open group — whether its body contains a quantifier */
  const stack = [];
  let inClass = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (c === '\\') {
      i++; // skip the escaped character entirely
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }

    if (c === '(') {
      stack.push(false);
      continue;
    }
    if (c === ')') {
      const bodyHadQuant = stack.pop() || false;
      const next = src[i + 1];
      const quantified = next === '*' || next === '+' || next === '?' || next === '{';
      const unbounded = next === '*' || next === '+' || next === '{';

      // Dangerous: the group repeats unboundedly and its body already contains a quantifier.
      if (unbounded && bodyHadQuant) return true;

      // Transitively: for the parent this group = "a quantifier in the body" if it
      // is itself quantified OR its body already contained a quantifier.
      if (stack.length && (quantified || bodyHadQuant)) {
        stack[stack.length - 1] = true;
      }
      continue;
    }

    if (c === '*' || c === '+' || c === '?' || c === '{') {
      if (stack.length) stack[stack.length - 1] = true;
    }
  }
  return false;
}

/**
 * Whether there is a {n}, {n,}, {n,m} repeat with a number greater than MAX_REPEAT.
 * Ignores escaping and character classes.
 * @param {string} src
 * @returns {boolean}
 */
function hasHugeRepeat(src) {
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '{') {
      const close = src.indexOf('}', i);
      if (close === -1) continue;
      const body = src.slice(i + 1, close); // "n" | "n," | "n,m"
      for (const part of body.split(',')) {
        const t = part.trim();
        if (/^\d+$/.test(t) && Number(t) > MAX_REPEAT) return true;
      }
      i = close;
    }
  }
  return false;
}

/**
 * Compile a user pattern into a RegExp with preventive protection.
 * Never throws.
 *
 * @param {string} pattern
 * @param {string} [flags]  default 'i' (no 'g' — so .test() is stateless)
 * @returns {{ ok: true, re: RegExp, reason: null } | { ok: false, re: null, reason: string }}
 */
export function safeRegExp(pattern, flags = 'i') {
  const src = String(pattern ?? '');

  if (src.length === 0) return { ok: false, re: null, reason: 'empty' };
  if (src.length > MAX_PATTERN_LENGTH) return { ok: false, re: null, reason: 'too-long' };
  if (hasHugeRepeat(src)) return { ok: false, re: null, reason: 'huge-repeat' };
  if (hasNestedQuantifier(src)) return { ok: false, re: null, reason: 'nested-quantifier' };

  try {
    return { ok: true, re: new RegExp(src, flags), reason: null };
  } catch {
    return { ok: false, re: null, reason: 'invalid-syntax' };
  }
}

/**
 * A ready predicate for filtering lists. Encapsulates "regex-if-safe, otherwise
 * substring", removing inline new RegExp and fallback logic from components.
 *
 * - empty query → passes everything;
 * - regex: true and the pattern is safe → match by regex (flag 'i');
 * - regex: false, or the pattern is dangerous/broken → case-insensitive substring.
 *
 * @param {string} query
 * @param {{ regex?: boolean }} [opts]
 * @returns {(text: string) => boolean}
 */
export function makeMatcher(query, { regex = true } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return () => true;

  if (regex) {
    const res = safeRegExp(q, 'i');
    if (res.ok) {
      const re = res.re;
      return (text) => re.test(String(text ?? ''));
    }
  }

  const needle = q.toLowerCase();
  return (text) => String(text ?? '').toLowerCase().includes(needle);
}
