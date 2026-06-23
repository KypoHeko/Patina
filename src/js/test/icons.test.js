import { describe, it, expect } from 'vitest';
import { fileIcon, hasOwnIcon, GLYPHS, EXT } from '../lib/icons.js';

describe('fileIcon', () => {
  it('a folder is rendered with the yellow folder icon', () => {
    const svg = fileIcon({ kind: 'folder', extension: null });
    expect(svg).toContain('<svg');
    expect(svg).toContain('#eab308'); // FOLDER_COLOR
  });

  it('a known code extension gets its own color (.js → yellow)', () => {
    const svg = fileIcon({ kind: 'file', extension: 'js' });
    expect(svg).toContain('#f7df1e');
  });

  it('extension is case-insensitive (JS == js)', () => {
    expect(fileIcon({ kind: 'file', extension: 'JS' }))
      .toBe(fileIcon({ kind: 'file', extension: 'js' }));
  });

  it('an unknown extension falls back to the default color', () => {
    const svg = fileIcon({ kind: 'file', extension: 'zzz' });
    expect(svg).toContain('#94a3b8'); // DEFAULT
  });

  it('a null/missing extension does not crash and yields the default', () => {
    const svg = fileIcon({ kind: 'file', extension: null });
    expect(svg).toContain('#94a3b8');
  });

  it('always returns a valid closed SVG with a viewBox', () => {
    const svg = fileIcon({ kind: 'file', extension: 'rs' });
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('the color is set on both stroke and color (for currentColor glyphs)', () => {
    const svg = fileIcon({ kind: 'file', extension: 'json' });
    expect(svg).toContain('stroke="#f59e0b"');
    expect(svg).toContain('color="#f59e0b"');
  });
});

describe('icon map integrity', () => {
  it('every EXT entry references a defined glyph and a valid hex color', () => {
    for (const [ext, value] of Object.entries(EXT)) {
      expect(Array.isArray(value), `.${ext} must be [glyph, color]`).toBe(true);
      const [glyph, color] = value;
      expect(GLYPHS[glyph], `glyph "${glyph}" for .${ext} is undefined`).toBeTruthy();
      expect(color, `color for .${ext}`).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    }
  });

  it('renders the mapped glyph (e.g. a presentation, not the generic file)', () => {
    const ppt = fileIcon({ kind: 'file', extension: 'pptx' });
    expect(ppt).toContain('m7 21 5-5 5 5'); // tail of the presentation glyph
    expect(ppt).toContain('#ea580c');
  });
});

describe('hasOwnIcon — expanded coverage', () => {
  const ours = [
    'pptx', 'ppt', 'odp', 'key', 'epub', 'mobi', 'apk', 'deb', 'dmg', 'sqlite',
    'mp4', 'mkv', 'mp3', 'flac', 'zip', '7z', 'tgz', 'svg', 'heic', 'kt', 'swift',
    'vue', 'xlsx', 'csv', 'ttf', 'bat', 'ps1', 'jar', 'iso',
  ];
  it.each(ours)('has our icon for .%s', (ext) => {
    expect(hasOwnIcon({ kind: 'file', extension: ext })).toBe(true);
  });

  it('still falls back to native for unknown / extensionless files', () => {
    expect(hasOwnIcon({ kind: 'file', extension: 'zzz' })).toBe(false);
    expect(hasOwnIcon({ kind: 'file', extension: '' })).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hasOwnIcon({ kind: 'file', extension: 'PPTX' })).toBe(true);
    expect(hasOwnIcon({ kind: 'file', extension: 'Mp4' })).toBe(true);
  });
});
