import { describe, it, expect, beforeEach } from 'vitest';
import { startDrag, getDrag, clearDrag } from '../state/drag.js';

describe('drag state', () => {
  beforeEach(() => {
    clearDrag();
  });

  it('initially null', () => {
    expect(getDrag()).toBeNull();
  });

  it('startDrag sets the state', () => {
    startDrag(['/a', '/b'], 'left');
    const drag = getDrag();
    expect(drag).toEqual({ paths: ['/a', '/b'], sourceSide: 'left' });
  });

  it('clearDrag resets to null', () => {
    startDrag(['/x'], 'right');
    clearDrag();
    expect(getDrag()).toBeNull();
  });

  it('the last startDrag overwrites the previous one', () => {
    startDrag(['/a'], 'left');
    startDrag(['/b', '/c'], 'right');
    expect(getDrag().paths).toEqual(['/b', '/c']);
    expect(getDrag().sourceSide).toBe('right');
  });
});
