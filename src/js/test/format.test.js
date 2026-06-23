import { describe, it, expect } from 'vitest';
import { formatSize, formatDate } from '../lib/format.js';

describe('formatSize', () => {
  it('bytes', () => {
    expect(formatSize(500)).toBe('500 B');
  });

  it('kilobytes', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
  });

  it('megabytes', () => {
    expect(formatSize(1048576)).toBe('1.0 MB');
  });

  it('gigabytes', () => {
    expect(formatSize(1073741824)).toBe('1.0 GB');
  });

  it('terabytes', () => {
    expect(formatSize(1099511627776)).toBe('1.0 TB');
  });

  it('zero and negative numbers → dash', () => {
    expect(formatSize(0)).toBe('—');
    expect(formatSize(-1)).toBe('—');
  });

  it('NaN / Infinity → dash', () => {
    expect(formatSize(NaN)).toBe('—');
    expect(formatSize(Infinity)).toBe('—');
  });

  it('bytes without a fractional part', () => {
    expect(formatSize(1)).toBe('1 B');
    expect(formatSize(42)).toBe('42 B');
  });
});

describe('formatDate', () => {
  it('returns a string for a valid timestamp', () => {
    const result = formatDate(1700000000000);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns an empty string for falsy values', () => {
    expect(formatDate(0)).toBe('');
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });
});
