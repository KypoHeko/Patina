import { describe, it, expect } from 'vitest';
import { KEYMAP } from '../config/keymap.js';
import { TAGS } from '../config/tags.js';

describe('KEYMAP (hotkey layout)', () => {
  it('each entry has combo, action and description', () => {
    for (const b of KEYMAP) {
      expect(typeof b.combo).toBe('string');
      expect(b.combo.length).toBeGreaterThan(0);
      expect(typeof b.action).toBe('string');
      expect(b.action.length).toBeGreaterThan(0);
      expect(typeof b.description).toBe('string');
      expect(b.description.length).toBeGreaterThan(0);
    }
  });

  it('no two actions share a combo (otherwise one would shadow the other)', () => {
    const combos = KEYMAP.map((b) => b.combo.toLowerCase());
    expect(new Set(combos).size).toBe(combos.length);
  });

  it('actions are unique', () => {
    const actions = KEYMAP.map((b) => b.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('contains the declared core shortcuts', () => {
    const byAction = Object.fromEntries(KEYMAP.map((b) => [b.action, b.combo]));
    expect(byAction['command-palette']).toBe('ctrl+k');
    expect(byAction['duplicates']).toBe('ctrl+d');
    expect(byAction['relationship-graph']).toBe('ctrl+g');
  });
});

describe('TAGS (predefined tags)', () => {
  it('exactly five declared tags', () => {
    expect(TAGS.map((t) => t.id).sort()).toEqual(
      ['archive', 'done', 'in-progress', 'reference', 'urgent'].sort()
    );
  });

  it('ids are unique', () => {
    const ids = TAGS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each tag has a non-empty label and a color token', () => {
    for (const t of TAGS) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.color).toMatch(/^var\(--tag-[a-z]+\)$/);
    }
  });
});
