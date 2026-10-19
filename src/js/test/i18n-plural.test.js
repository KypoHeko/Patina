import { describe, it, expect, afterEach } from 'vitest';
import { t, setLang } from '../lib/i18n.js';

describe('i18n plural forms', () => {
  afterEach(() => setLang('ru'));

  it('Russian picks one / few / many', () => {
    setLang('ru');
    expect(t('status.files', { n: 1 })).toBe('1 файл');
    expect(t('status.files', { n: 3 })).toBe('3 файла');
    expect(t('status.files', { n: 5 })).toBe('5 файлов');
    expect(t('status.files', { n: 21 })).toBe('21 файл');
    expect(t('status.folders', { n: 2 })).toBe('2 папки');
  });

  it('English picks one / other', () => {
    setLang('en');
    expect(t('status.files', { n: 1 })).toBe('1 file');
    expect(t('status.files', { n: 2 })).toBe('2 files');
  });

  it('system locations are translated by kind', () => {
    setLang('en');
    expect(t('loc.downloads')).toBe('Downloads');
    setLang('ru');
    expect(t('loc.downloads')).toBe('Загрузки');
  });
});
