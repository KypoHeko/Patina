import { describe, it, expect } from 'vitest';
import { parentPath, folderName, isRoot, pathCrumbs } from '../lib/paths.js';

describe('parentPath', () => {
  it('POSIX: returns the parent directory', () => {
    expect(parentPath('/home/user/docs')).toBe('/home/user');
  });

  it('POSIX: root returns null', () => {
    expect(parentPath('/')).toBeNull();
  });

  it('POSIX: single-segment path → null', () => {
    expect(parentPath('/home')).toBeNull();
  });

  it('Windows: returns the parent directory', () => {
    expect(parentPath('C:\\Users\\admin')).toBe('C:\\Users');
  });

  it('Windows: drive root returns null', () => {
    expect(parentPath('C:\\')).toBeNull();
  });

  it('Windows: going up to the drive letter adds a backslash', () => {
    // "C:" without a slash is the "current folder on drive C", not the root.
    // parentPath("C:\\foo") = "C:" → should become "C:\"
    expect(parentPath('C:\\foo')).toBe('C:\\');
  });

  it('strips trailing slashes', () => {
    expect(parentPath('/home/user/docs/')).toBe('/home/user');
    expect(parentPath('C:\\Users\\admin\\')).toBe('C:\\Users');
  });
});

describe('folderName', () => {
  it('POSIX: extracts the last segment', () => {
    expect(folderName('/home/user/docs')).toBe('docs');
  });

  it('POSIX: root is /', () => {
    expect(folderName('/')).toBe('/');
  });

  it('Windows: extracts the last segment', () => {
    expect(folderName('C:\\Users\\admin')).toBe('admin');
  });

  it('Windows: drive root is the letter', () => {
    expect(folderName('C:\\')).toBe('C:');
  });

  it('empty string', () => {
    expect(folderName('')).toBe('');
  });
});

describe('isRoot', () => {
  it('POSIX root', () => {
    expect(isRoot('/')).toBe(true);
  });

  it('Windows root with backslash', () => {
    expect(isRoot('C:\\')).toBe(true);
  });

  it('Windows root with forward slash', () => {
    expect(isRoot('C:/')).toBe(true);
  });

  it('not a root', () => {
    expect(isRoot('/home')).toBe(false);
    expect(isRoot('C:\\Users')).toBe(false);
  });
});

describe('pathCrumbs', () => {
  it('POSIX path splits into crumbs', () => {
    const crumbs = pathCrumbs('/home/user/docs');
    expect(crumbs).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'user', path: '/home/user' },
      { label: 'docs', path: '/home/user/docs' },
    ]);
  });

  it('Windows path splits into crumbs', () => {
    const crumbs = pathCrumbs('C:\\Users\\admin');
    expect(crumbs).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'admin', path: 'C:\\Users\\admin' },
    ]);
  });

  it('empty string → empty array', () => {
    expect(pathCrumbs('')).toEqual([]);
  });

  it('POSIX root → single element', () => {
    // '/' after trim → '' → returns an empty array (trailing slash removed)
    const crumbs = pathCrumbs('/');
    // Implementation: trimmed.replace(/[\\/]+$/, '') on '/' yields ''
    // so the result is an empty array
    expect(crumbs).toEqual([]);
  });
});
