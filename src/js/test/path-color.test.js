import { describe, it, expect } from 'vitest';
import { pathToColor, textColorFor } from '../lib/path-color.js';

describe('pathToColor', () => {
  it('возвращает валидный 7-символьный hex-цвет', () => {
    const c = pathToColor('C:\\Users\\me\\project');
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('детерминирован: один путь — один цвет', () => {
    expect(pathToColor('/home/a')).toBe(pathToColor('/home/a'));
  });

  it('разные пути обычно дают разные цвета', () => {
    expect(pathToColor('/home/a')).not.toBe(pathToColor('/home/b'));
  });

  it('каждый канал лежит в смешанном диапазоне 60..225 (без слишком тёмных/слепящих)', () => {
    for (const p of ['', 'x', '/very/long/path/here', 'D:\\data', 'пример/кириллица']) {
      const c = pathToColor(p);
      for (let i = 1; i < 7; i += 2) {
        const v = parseInt(c.slice(i, i + 2), 16);
        expect(v).toBeGreaterThanOrEqual(60);
        expect(v).toBeLessThanOrEqual(225);
      }
    }
  });

  it('пустая строка не падает и даёт валидный цвет', () => {
    expect(pathToColor('')).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('textColorFor', () => {
  it('тёмный текст на светлом фоне', () => {
    expect(textColorFor('#ffffff')).toBe('#0a0a0f');
  });

  it('светлый текст на тёмном фоне', () => {
    expect(textColorFor('#000000')).toBe('#f5f5f5');
  });

  it('усредняет яркость нескольких цветов', () => {
    // два белых → светло → тёмный текст
    expect(textColorFor('#ffffff', '#ffffff')).toBe('#0a0a0f');
    // белый + чёрный → среднее ~127 (< 150) → светлый текст
    expect(textColorFor('#ffffff', '#000000')).toBe('#f5f5f5');
  });
});
