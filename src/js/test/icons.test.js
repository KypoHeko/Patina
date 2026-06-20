import { describe, it, expect } from 'vitest';
import { fileIcon } from '../lib/icons.js';

describe('fileIcon', () => {
  it('папка отрисовывается жёлтой иконкой папки', () => {
    const svg = fileIcon({ kind: 'folder', extension: null });
    expect(svg).toContain('<svg');
    expect(svg).toContain('#eab308'); // FOLDER_COLOR
  });

  it('известное расширение кода получает свой цвет (.js → жёлтый)', () => {
    const svg = fileIcon({ kind: 'file', extension: 'js' });
    expect(svg).toContain('#f7df1e');
  });

  it('расширение регистронезависимо (JS == js)', () => {
    expect(fileIcon({ kind: 'file', extension: 'JS' }))
      .toBe(fileIcon({ kind: 'file', extension: 'js' }));
  });

  it('неизвестное расширение откатывается к дефолтному цвету', () => {
    const svg = fileIcon({ kind: 'file', extension: 'zzz' });
    expect(svg).toContain('#94a3b8'); // DEFAULT
  });

  it('null/отсутствующее расширение не падает и даёт дефолт', () => {
    const svg = fileIcon({ kind: 'file', extension: null });
    expect(svg).toContain('#94a3b8');
  });

  it('всегда возвращает корректный замкнутый SVG с viewBox', () => {
    const svg = fileIcon({ kind: 'file', extension: 'rs' });
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('цвет проставляется и в stroke, и в color (для currentColor-глифов)', () => {
    const svg = fileIcon({ kind: 'file', extension: 'json' });
    expect(svg).toContain('stroke="#f59e0b"');
    expect(svg).toContain('color="#f59e0b"');
  });
});
