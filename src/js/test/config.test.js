import { describe, it, expect } from 'vitest';
import { KEYMAP } from '../config/keymap.js';
import { TAGS } from '../config/tags.js';

describe('KEYMAP (раскладка горячих клавиш)', () => {
  it('каждая запись имеет combo, action и description', () => {
    for (const b of KEYMAP) {
      expect(typeof b.combo).toBe('string');
      expect(b.combo.length).toBeGreaterThan(0);
      expect(typeof b.action).toBe('string');
      expect(b.action.length).toBeGreaterThan(0);
      expect(typeof b.description).toBe('string');
      expect(b.description.length).toBeGreaterThan(0);
    }
  });

  it('нет двух действий на одной комбинации (иначе одно перекроет другое)', () => {
    const combos = KEYMAP.map((b) => b.combo.toLowerCase());
    expect(new Set(combos).size).toBe(combos.length);
  });

  it('действия уникальны', () => {
    const actions = KEYMAP.map((b) => b.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('содержит заявленные основные шорткаты', () => {
    const byAction = Object.fromEntries(KEYMAP.map((b) => [b.action, b.combo]));
    expect(byAction['command-palette']).toBe('ctrl+k');
    expect(byAction['duplicates']).toBe('ctrl+d');
    expect(byAction['relationship-graph']).toBe('ctrl+g');
  });
});

describe('TAGS (предопределённые теги)', () => {
  it('ровно пять заявленных тегов', () => {
    expect(TAGS.map((t) => t.id).sort()).toEqual(
      ['archive', 'done', 'in-progress', 'reference', 'urgent'].sort()
    );
  });

  it('id уникальны', () => {
    const ids = TAGS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('у каждого тега есть непустой label и цветовой токен', () => {
    for (const t of TAGS) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.color).toMatch(/^var\(--tag-[a-z]+\)$/);
    }
  });
});
