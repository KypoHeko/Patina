import { describe, it, expect, beforeEach } from 'vitest';
import { startDrag, getDrag, clearDrag } from './drag.js';

describe('drag state', () => {
  beforeEach(() => {
    clearDrag();
  });

  it('изначально null', () => {
    expect(getDrag()).toBeNull();
  });

  it('startDrag устанавливает состояние', () => {
    startDrag(['/a', '/b'], 'left');
    const drag = getDrag();
    expect(drag).toEqual({ paths: ['/a', '/b'], sourceSide: 'left' });
  });

  it('clearDrag сбрасывает в null', () => {
    startDrag(['/x'], 'right');
    clearDrag();
    expect(getDrag()).toBeNull();
  });

  it('последний startDrag перезаписывает предыдущий', () => {
    startDrag(['/a'], 'left');
    startDrag(['/b', '/c'], 'right');
    expect(getDrag().paths).toEqual(['/b', '/c']);
    expect(getDrag().sourceSide).toBe('right');
  });
});
