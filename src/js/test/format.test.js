import { describe, it, expect } from 'vitest';
import { formatSize, formatDate } from './format.js';

describe('formatSize', () => {
  it('байты', () => {
    expect(formatSize(500)).toBe('500 B');
  });

  it('килобайты', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
  });

  it('мегабайты', () => {
    expect(formatSize(1048576)).toBe('1.0 MB');
  });

  it('гигабайты', () => {
    expect(formatSize(1073741824)).toBe('1.0 GB');
  });

  it('терабайты', () => {
    expect(formatSize(1099511627776)).toBe('1.0 TB');
  });

  it('нуль и отрицательные числа — тире', () => {
    expect(formatSize(0)).toBe('—');
    expect(formatSize(-1)).toBe('—');
  });

  it('NaN / Infinity — тире', () => {
    expect(formatSize(NaN)).toBe('—');
    expect(formatSize(Infinity)).toBe('—');
  });

  it('байты без дробной части', () => {
    expect(formatSize(1)).toBe('1 B');
    expect(formatSize(42)).toBe('42 B');
  });
});

describe('formatDate', () => {
  it('возвращает строку для валидного timestamp', () => {
    const result = formatDate(1700000000000);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('возвращает пустую строку для falsy значений', () => {
    expect(formatDate(0)).toBe('');
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });
});
