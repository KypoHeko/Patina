import { describe, it, expect, vi } from 'vitest';
import { PreviewPanel } from '../components/preview-panel.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState } from '../state/tabs.js';

vi.mock('../api/invoke.js', () => ({
  invoke: vi.fn(),
  assetUrl: (p) => (p ? 'asset://localhost/' + encodeURIComponent(p) : ''),
}));
vi.mock('../api/fs.js', () => ({ readPreview: vi.fn().mockResolvedValue(null) }));
vi.mock('../api/versions.js', () => ({
  snapshotVersion: vi.fn(),
  listVersions: vi.fn().mockResolvedValue([]),
  restoreVersion: vi.fn(),
  deleteVersion: vi.fn(),
}));
vi.mock('../api/tags.js', () => ({ tagsForPaths: vi.fn().mockResolvedValue({}) }));

function makePanel() {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const panel = new PreviewPanel({ mount, store: createStore({ ...initialTabsState() }), bus: createEventBus() });
  panel.init();
  panel._open = true;
  panel._versions = [];
  panel._currentVerId = null;
  return panel;
}

describe('PreviewPanel — image source', () => {
  it('loads the cached thumbnail via the asset protocol (no base64)', () => {
    const panel = makePanel();
    panel._path = '/pics/p.png';
    panel._preview = { kind: 'image', name: 'p.png', thumbPath: '/cache/abc.jpg', dataUrl: null, size: 1, modified: 1, created: 1 };
    panel.renderFrame();

    const img = panel.mount.querySelector('.pv__img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('asset://localhost/' + encodeURIComponent('/cache/abc.jpg'));
  });

  it('falls back to a data URL when there is no thumbnail (e.g. SVG)', () => {
    const panel = makePanel();
    panel._path = '/pics/v.svg';
    panel._preview = { kind: 'image', name: 'v.svg', thumbPath: null, dataUrl: 'data:image/svg+xml;base64,XYZ', size: 1, modified: 1, created: 1 };
    panel.renderFrame();

    const img = panel.mount.querySelector('.pv__img');
    expect(img.getAttribute('src')).toBe('data:image/svg+xml;base64,XYZ');
  });
});
