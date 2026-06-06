// @ts-check
//! Безопасная компиляция пользовательских регулярных выражений.
//!
//! Движок RegExp в JS — бэктрекинговый, поэтому «злые» паттерны вроде (a+)+$
//! на неудачном вводе дают экспоненциальное время на ГЛАВНОМ потоке (ReDoS):
//! интерфейс намертво виснет. Прервать синхронный .test() на том же потоке
//! нельзя, поэтому защита здесь ПРЕВЕНТИВНАЯ — отсекаем опасное ДО запуска:
//!   1) ограничиваем длину паттерна;
//!   2) режем гигантские повторы {n,m};
//!   3) эвристически отсеиваем вложенные неограниченные квантификаторы
//!      ((a+)+, (.*)* и т.п. — классическая причина катастрофического бэктрекинга).
//!
//! Это не пуленепробиваемо (см. примечание в конце), но снимает типовые случаи.
//! Любой отклонённый паттерн = тихая деградация до поиска по подстроке, а не сбой:
//! вызывающий код всегда получает рабочий матчер.

/** Максимальная длина паттерна. Длиннее — сразу в фолбэк. */
export const MAX_PATTERN_LENGTH = 200;

/** Верхняя граница счётчика в {n}, {n,}, {n,m}. Больше — в фолбэк. */
export const MAX_REPEAT = 1000;

/**
 * Эвристика катастрофического бэктрекинга: есть ли в паттерне группа,
 * квантифицированная неограниченно (`*`, `+`, `{…`), чьё тело само содержит
 * квантификатор — на любой глубине вложенности. Это (a+)+, (.*)* , ((a+))+ …
 *
 * Корректно игнорирует экранированные скобки (`\(`) и содержимое классов `[…]`,
 * где `(`, `+`, `*` — литералы. Альтернацию саму по себе НЕ считает опасной
 * ((a|b)* линейна), чтобы не плодить ложные отказы.
 *
 * @param {string} src
 * @returns {boolean}
 */
export function hasNestedQuantifier(src) {
  /** @type {boolean[]} стек: для каждой открытой группы — содержит ли её тело квантификатор */
  const stack = [];
  let inClass = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (c === '\\') {
      i++; // пропускаем экранированный символ целиком
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

      // Опасно: группа повторяется неограниченно, а её тело уже содержит квантификатор.
      if (unbounded && bodyHadQuant) return true;

      // Транзитивно: для родителя эта группа = «квантификатор в теле», если она
      // сама квантифицирована ИЛИ её тело уже содержало квантификатор.
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
 * Есть ли повтор {n}, {n,}, {n,m} с числом больше MAX_REPEAT.
 * Игнорирует экранирование и классы символов.
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
 * Скомпилировать пользовательский паттерн в RegExp с превентивной защитой.
 * Никогда не бросает исключение.
 *
 * @param {string} pattern
 * @param {string} [flags]  по умолчанию 'i' (без 'g' — чтобы .test() был без состояния)
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
 * Готовый предикат для фильтрации списков. Инкапсулирует «regex-если-безопасно,
 * иначе подстрока», убирая inline new RegExp и логику фолбэка из компонентов.
 *
 * - пустой запрос → пропускает всё;
 * - regex: true и паттерн безопасен → матч регуляркой (флаг 'i');
 * - regex: false, либо паттерн опасен/битый → регистронезависимая подстрока.
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
