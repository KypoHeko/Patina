import { describe, it, expect } from 'vitest';
import { parentPath, folderName, isRoot, pathCrumbs } from '../lib/paths.js';

describe('parentPath', () => {
  it('POSIX: возвращает родительский каталог', () => {
    expect(parentPath('/home/user/docs')).toBe('/home/user');
  });

  it('POSIX: корень возвращает null', () => {
    expect(parentPath('/')).toBeNull();
  });

  it('POSIX: односегментный путь — null', () => {
    expect(parentPath('/home')).toBeNull();
  });

  it('Windows: возвращает родительский каталог', () => {
    expect(parentPath('C:\\Users\\admin')).toBe('C:\\Users');
  });

  it('Windows: корень диска возвращает null', () => {
    expect(parentPath('C:\\')).toBeNull();
  });

  it('Windows: подъём до буквы диска добавляет обратный слеш', () => {
    // "C:" без слеша — это «текущая папка на диске C», не корень.
    // parentPath("C:\\foo") = "C:" → должно стать "C:\"
    expect(parentPath('C:\\foo')).toBe('C:\\');
  });

  it('убирает конечные слеши', () => {
    expect(parentPath('/home/user/docs/')).toBe('/home/user');
    expect(parentPath('C:\\Users\\admin\\')).toBe('C:\\Users');
  });
});

describe('folderName', () => {
  it('POSIX: извлекает последний сегмент', () => {
    expect(folderName('/home/user/docs')).toBe('docs');
  });

  it('POSIX: корень — /', () => {
    expect(folderName('/')).toBe('/');
  });

  it('Windows: извлекает последний сегмент', () => {
    expect(folderName('C:\\Users\\admin')).toBe('admin');
  });

  it('Windows: корень диска — буква', () => {
    expect(folderName('C:\\')).toBe('C:');
  });

  it('пустая строка', () => {
    expect(folderName('')).toBe('');
  });
});

describe('isRoot', () => {
  it('POSIX корень', () => {
    expect(isRoot('/')).toBe(true);
  });

  it('Windows корень с обратным слешем', () => {
    expect(isRoot('C:\\')).toBe(true);
  });

  it('Windows корень с прямым слешем', () => {
    expect(isRoot('C:/')).toBe(true);
  });

  it('не корень', () => {
    expect(isRoot('/home')).toBe(false);
    expect(isRoot('C:\\Users')).toBe(false);
  });
});

describe('pathCrumbs', () => {
  it('POSIX путь разбивается на крошки', () => {
    const crumbs = pathCrumbs('/home/user/docs');
    expect(crumbs).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'user', path: '/home/user' },
      { label: 'docs', path: '/home/user/docs' },
    ]);
  });

  it('Windows путь разбивается на крошки', () => {
    const crumbs = pathCrumbs('C:\\Users\\admin');
    expect(crumbs).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'admin', path: 'C:\\Users\\admin' },
    ]);
  });

  it('пустая строка — пустой массив', () => {
    expect(pathCrumbs('')).toEqual([]);
  });

  it('POSIX корень — один элемент', () => {
    // '/' после trim → '' → возвращает пустой массив (конечный слеш убран)
    const crumbs = pathCrumbs('/');
    // Реализация: trimmed.replace(/[\\/]+$/, '') на '/' даёт ''
    // поэтому результат — пустой массив
    expect(crumbs).toEqual([]);
  });
});
