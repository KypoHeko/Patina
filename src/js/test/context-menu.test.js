import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the tags API boundary — in jsdom there is no real Tauri IPC.
vi.mock('../api/tags.js', () => ({
  assignTag: vi.fn().mockResolvedValue(undefined),
  removeTag: vi.fn().mockResolvedValue(undefined),
  tagsForPaths: vi.fn().mockResolvedValue({}),
}));

import { ContextMenu } from '../components/context-menu.js';
import { assignTag, removeTag, tagsForPaths } from '../api/tags.js';
import { TAGS } from '../config/tags.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';

function makeCtx() {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return { mount, store: createStore({}), bus: createEventBus() };
}

// Flush microtasks + the async openAt()/toggleTag() chains.
const tick = () => new Promise((r) => setTimeout(r, 0));

const TAG = TAGS[0].id; // 'urgent'

describe('ContextMenu — multi-select tagging', () => {
  beforeEach(() => {
    assignTag.mockClear();
    removeTag.mockClear();
    tagsForPaths.mockClear();
  });

  it('assigns a tag to EVERY selected path, not just the right-clicked one', async () => {
    const ctx = makeCtx();
    const menu = new ContextMenu(ctx);
    menu.init();

    const paths = ['C:\\a\\1.txt', 'C:\\a\\2.txt', 'C:\\a\\3.txt'];
    // Right-clicked the 3rd file, but all three are selected.
    ctx.bus.emit('contextmenu:open', {
      x: 10,
      y: 10,
      side: 'left',
      entry: { path: paths[2], name: '3.txt', kind: 'file' },
      paths,
    });
    await tick(); // openAt() resolves tagsForPaths (returns {} → no common tags)

    const dot = ctx.mount.querySelector(`.ctx-tag[data-tag="${TAG}"]`);
    expect(dot).toBeTruthy();
    expect(dot.classList.contains('is-on')).toBe(false);

    dot.click();
    await tick(); // toggleTag() resolves Promise.all(assignTag...)

    expect(assignTag).toHaveBeenCalledTimes(3);
    for (const p of paths) expect(assignTag).toHaveBeenCalledWith(p, TAG);
    expect(removeTag).not.toHaveBeenCalled();
    expect(dot.classList.contains('is-on')).toBe(true);
  });

  it('removes a tag from ALL selected paths when every one already has it', async () => {
    const ctx = makeCtx();
    const menu = new ContextMenu(ctx);
    menu.init();

    const paths = ['C:\\a\\1.txt', 'C:\\a\\2.txt'];
    // Both files already carry the tag → the dot is "on" (intersection) → toggling removes it.
    tagsForPaths.mockResolvedValueOnce({ [paths[0]]: [TAG], [paths[1]]: [TAG] });
    ctx.bus.emit('contextmenu:open', {
      x: 10,
      y: 10,
      side: 'left',
      entry: { path: paths[0], name: '1.txt', kind: 'file' },
      paths,
    });
    await tick();

    const dot = ctx.mount.querySelector(`.ctx-tag[data-tag="${TAG}"]`);
    expect(dot.classList.contains('is-on')).toBe(true);

    dot.click();
    await tick();

    expect(removeTag).toHaveBeenCalledTimes(2);
    for (const p of paths) expect(removeTag).toHaveBeenCalledWith(p, TAG);
    expect(assignTag).not.toHaveBeenCalled();
  });

  it('a tag present on only SOME selected paths is treated as not-common → assigned to all', async () => {
    const ctx = makeCtx();
    const menu = new ContextMenu(ctx);
    menu.init();

    const paths = ['C:\\a\\1.txt', 'C:\\a\\2.txt'];
    // Only the first file has the tag → not common → dot stays off → click assigns to all.
    tagsForPaths.mockResolvedValueOnce({ [paths[0]]: [TAG] });
    ctx.bus.emit('contextmenu:open', {
      x: 10,
      y: 10,
      side: 'left',
      entry: { path: paths[0], name: '1.txt', kind: 'file' },
      paths,
    });
    await tick();

    const dot = ctx.mount.querySelector(`.ctx-tag[data-tag="${TAG}"]`);
    expect(dot.classList.contains('is-on')).toBe(false);

    dot.click();
    await tick();

    expect(assignTag).toHaveBeenCalledTimes(2);
    for (const p of paths) expect(assignTag).toHaveBeenCalledWith(p, TAG);
  });
});
