import { describe, it, expect } from 'vitest';
import {
  safeRegExp,
  hasNestedQuantifier,
  makeMatcher,
  MAX_PATTERN_LENGTH,
} from './regex.js';

describe('safeRegExp', () => {
  it('простой паттерн компилируется', () => {
    const res = safeRegExp('hello');
    expect(res.ok).toBe(true);
    expect(res.re).toBeInstanceOf(RegExp);
    expect(res.reason).toBeNull();
  });

  it('пустой паттерн отклонён', () => {
    const res = safeRegExp('');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('empty');
  });

  it('слишком длинный паттерн отклонён', () => {
    const long = 'a'.repeat(MAX_PATTERN_LENGTH + 1);
    const res = safeRegExp(long);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('too-long');
  });

  it('вложенные квантификаторы отклонены: (a+)+', () => {
    const res = safeRegExp('(a+)+');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('nested-quantifier');
  });

  it('вложенные квантификаторы отклонены: (.*)*', () => {
    const res = safeRegExp('(.*)*');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('nested-quantifier');
  });

  it('гигантский повтор отклонён: a{9999}', () => {
    const res = safeRegExp('a{9999}');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('huge-repeat');
  });

  it('невалидный синтаксис отклонён', () => {
    const res = safeRegExp('[invalid');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid-syntax');
  });

  it('простые чередования разрешены: (a|b)*', () => {
    const res = safeRegExp('(a|b)*');
    expect(res.ok).toBe(true);
  });

  it('флаги передаются', () => {
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
    ['(a+)', false],       // группа с квантификатором, но сама не квантифицирована безгранично
    ['(a|b)*', false],    // альтернация без вложенного квантификатора
    ['a+b+', false],      // последовательные — не вложенные
    ['(a*)+', true],      // a* внутри + — вложенный
    ['(\\()+', false],    // экранированная скобка — не группа
    ['[a+b]*', false],    // внутри класса символов — литералы
  ];

  for (const [pattern, expected] of cases) {
    it(`${pattern} → ${expected}`, () => {
      expect(hasNestedQuantifier(pattern)).toBe(expected);
    });
  }
});

describe('makeMatcher', () => {
  it('пустой запрос пропускает всё', () => {
    const match = makeMatcher('');
    expect(match('anything')).toBe(true);
    expect(match('')).toBe(true);
  });

  it('подстрока по умолчанию (regex: true, но безопасный паттерн)', () => {
    const match = makeMatcher('test');
    expect(match('my test file')).toBe(true);
    expect(match('MY TEST FILE')).toBe(true); // флаг 'i'
    expect(match('other')).toBe(false);
  });

  it('regex: false — поиск по подстроке', () => {
    const match = makeMatcher('foo', { regex: false });
    expect(match('foobar')).toBe(true);
    expect(match('FOOBAR')).toBe(true);
    expect(match('baz')).toBe(false);
  });

  it('опасный regex деградирует до подстроки', () => {
    const match = makeMatcher('(a+)+b', { regex: true });
    // (a+)+ — вложенный квантификатор, деградация до поиска подстроки "(a+)+b"
    // В режиме подстроки ищет буквальное совпадение "(a+)+b" в тексте (регистронезависимо)
    expect(match('(a+)+b')).toBe(true);
    expect(match('(A+)+B')).toBe(true); // регистронезависимо
    expect(match('xyz')).toBe(false);
  });

  it('безопасный regex работает как regex', () => {
    const match = makeMatcher('^test\\d+', { regex: true });
    expect(match('test123')).toBe(true);
    expect(match('atest123')).toBe(false);
  });
});
