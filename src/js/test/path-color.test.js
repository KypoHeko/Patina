import { describe, it, expect } from 'vitest';
import { pathToColor, textColorFor } from '../lib/path-color.js';

describe('pathToColor', () => {
  it('returns a valid 7-character hex color', () => {
    const c = pathToColor('C:\\Users\\me\\project');
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('deterministic: one path → one color', () => {
    expect(pathToColor('/home/a')).toBe(pathToColor('/home/a'));
  });

  it('different paths usually produce different colors', () => {
    expect(pathToColor('/home/a')).not.toBe(pathToColor('/home/b'));
  });

  it('each channel lies in the mixed range 60..225 (no too-dark/too-bright values)', () => {
    for (const p of ['', 'x', '/very/long/path/here', 'D:\\data', 'пример/кириллица']) {
      const c = pathToColor(p);
      for (let i = 1; i < 7; i += 2) {
        const v = parseInt(c.slice(i, i + 2), 16);
        expect(v).toBeGreaterThanOrEqual(60);
        expect(v).toBeLessThanOrEqual(225);
      }
    }
  });

  it('empty string does not crash and yields a valid color', () => {
    expect(pathToColor('')).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('textColorFor', () => {
  it('dark text on a light background', () => {
    expect(textColorFor('#ffffff')).toBe('#0a0a0f');
  });

  it('light text on a dark background', () => {
    expect(textColorFor('#000000')).toBe('#f5f5f5');
  });

  it('averages the brightness of several colors', () => {
    // two whites → bright → dark text
    expect(textColorFor('#ffffff', '#ffffff')).toBe('#0a0a0f');
    // white + black → average ~127 (< 150) → light text
    expect(textColorFor('#ffffff', '#000000')).toBe('#f5f5f5');
  });
});
