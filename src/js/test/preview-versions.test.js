import { describe, it, expect, vi } from 'vitest';
import { PreviewPanel } from '../components/preview-panel.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState, getActiveSide } from '../state/tabs.js';
import { selectInPane } from '../state/panes.js';
import { currentVersion, deleteVersion } from '../api/versions.js';
import { t } from '../lib/i18n.js';

vi.mock('../api/invoke.js', () => ({ assetUrl: (p) => p }));
vi.mock('../api/fs.js', () => ({
  readPreview: vi.fn().mockResolvedValue({ kind: 'text', name: 'a.txt', text: 'x', size: 1, modified: 1, created: 1 }),
}));
vi.mock('../api/versions.js', () => ({
  snapshotVersion: vi.fn(),
  listVersions: vi.fn().mockResolvedValue([
    { id: 2, label: 'v2', ts: 2 },
    { id: 1, label: 'v1', ts: 1 },
  ]),
  currentVersion: vi.fn(),
  restoreVersion: vi.fn(),
  deleteVersion: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/tags.js', () => ({ tagsForPaths: vi.fn().mockResolvedValue({}) }));

const tick = () => new Promise((r) => setTimeout(r, 0));

async function openOn(path) {
  document.body.innerHTML = '<div class="main"></div>';
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const store = createStore({ ...initialTabsState(), homePath: '/' });
  const bus = createEventBus();
  const panel = new PreviewPanel({ mount, store, bus });
  panel.init();
  panel.openNow();
  selectInPane(store, getActiveSide(store.getState()), [path]);
  await tick();
  await tick();
  return { panel, mount, bus };
}

describe('PreviewPanel — versions', () => {
  it('marks as current the version equal to the file, not simply the newest', async () => {
    currentVersion.mockResolvedValue(1);
    const { panel } = await openOn('/a.txt');
    expect(panel._currentVerId).toBe(1);
  });

  it('marks none when the file has unsaved changes', async () => {
    currentVersion.mockResolvedValue(null);
    const { mount } = await openOn('/a.txt');
    expect(mount.textContent).toContain(t('pv.info.unsaved'));
    expect(mount.querySelector('.pv__ver-badge')).toBeNull();
  });

  it('asks for confirmation before deleting a version', async () => {
    currentVersion.mockResolvedValue(2);
    const { panel, mount, bus } = await openOn('/a.txt');
    const confirm = vi.fn();
    bus.on('confirm:open', confirm);
    panel._selectedVer = 1;
    panel.renderFrame();
    mount.querySelector('[data-del]').click();
    expect(deleteVersion).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mock.calls[0][0].onConfirm();
    expect(deleteVersion).toHaveBeenCalledWith(1);
  });
});
