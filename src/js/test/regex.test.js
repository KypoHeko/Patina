import { describe, it, expect } from 'vitest';
import {
  safeRegExp,
  hasNestedQuantifier,
  makeMatcher,
  MAX_PATTERN_LENGTH,
} from '../lib/regex.js';

describe('safeRegExp', () => {
  it('a simple pattern compiles', () => {
    const res = safeRegExp('hello');
    expect(res.ok).toBe(true);
    expect(res.re).toBeInstanceOf(RegExp);
    expect(res.reason).toBeNull();
  });

  it('an empty pattern is rejected', () => {
    const res = safeRegExp('');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('empty');
  });

  it('a too-long pattern is rejected', () => {
    const long = 'a'.repeat(MAX_PATTERN_LENGTH + 1);
    const res = safeRegExp(long);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('too-long');
  });

  it('nested quantifiers are rejected: (a+)+', () => {
    const res = safeRegExp('(a+)+');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('nested-quantifier');
  });

  it('nested quantifiers are rejected: (.*)*', () => {
    const res = safeRegExp('(.*)*');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('nested-quantifier');
  });

  it('a huge repeat is rejected: a{9999}', () => {
    const res = safeRegExp('a{9999}');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('huge-repeat');
  });

  it('invalid syntax is rejected', () => {
    const res = safeRegExp('[invalid');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid-syntax');
  });

  it('simple alternations are allowed: (a|b)*', () => {
    const res = safeRegExp('(a|b)*');
    expect(res.ok).toBe(true);
  });

  it('flags are passed through', () => {
    const res = safeRegExp('test', 'i');
    expect(res.ok).toBe(true);
    expect(res.re.flags).toContain('i');
  });
});

describe('hasNestedQuantifier', () => {
  const cases = [
    ['(a+)+', true],
    ['(.*)*', true],
    ['((a+))+', true],
    ['(a+)', false],       // group with a quantifier, but not itself unboundedly quantified
    ['(a|b)*', false],    // alternation without a nested quantifier
    ['a+b+', false],      // sequential — not nested
    ['(a*)+', true],      // a* inside + — nested
    ['(\\()+', false],    // escaped parenthesis — not a group
    ['[a+b]*', false],    // inside a character class — literals
  ];

  for (const [pattern, expected] of cases) {
    it(`${pattern} → ${expected}`, () => {
      expect(hasNestedQuantifier(pattern)).toBe(expected);
    });
  }
});

describe('makeMatcher', () => {
  it('an empty query passes everything', () => {
    const match = makeMatcher('');
    expect(match('anything')).toBe(true);
    expect(match('')).toBe(true);
  });

  it('substring by default (regex: true, but a safe pattern)', () => {
    const match = makeMatcher('test');
    expect(match('my test file')).toBe(true);
    expect(match('MY TEST FILE')).toBe(true); // 'i' flag
    expect(match('other')).toBe(false);
  });

  it('regex: false — substring search', () => {
    const match = makeMatcher('foo', { regex: false });
    expect(match('foobar')).toBe(true);
    expect(match('FOOBAR')).toBe(true);
    expect(match('baz')).toBe(false);
  });

  it('a dangerous regex degrades to substring', () => {
    const match = makeMatcher('(a+)+b', { regex: true });
    // (a+)+ — nested quantifier, degrades to substring search for "(a+)+b"
    // In substring mode it looks for a literal match of "(a+)+b" in the text (case-insensitive)
    expect(match('(a+)+b')).toBe(true);
    expect(match('(A+)+B')).toBe(true); // case-insensitive
    expect(match('xyz')).toBe(false);
  });

  it('a safe regex works as a regex', () => {
    const match = makeMatcher('^test\\d+', { regex: true });
    expect(match('test123')).toBe(true);
    expect(match('atest123')).toBe(false);
  });
});
