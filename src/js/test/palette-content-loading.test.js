import { describe, it, expect, vi } from 'vitest';
import { CommandPalette } from '../components/command-palette.js';
import { createStore } from '../core/store.js';
import { createEventBus } from '../core/event-bus.js';
import { initialTabsState, getActiveSide } from '../state/tabs.js';
import { updatePane } from '../state/panes.js';
import { searchContent } from '../api/content.js';
import { t } from '../lib/i18n.js';

vi.mock('../api/content.js', () => ({ searchContent: vi.fn() }));
vi.mock('../api/fs.js', () => ({ searchFiles: vi.fn().mockResolvedValue([]) }));
vi.mock('../api/indexing.js', () => ({ startIndex: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../api/tags.js', () => ({ pathsForTag: vi.fn(), tagsForPaths: vi.fn().mockResolvedValue({}) }));
vi.mock('../api/events.js', () => ({ onEvent: vi.fn().mockResolvedValue(() => {}) }));

const tick = () => new Promise((r) => setTimeout(r, 0));

function openPalette() {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const store = createStore({ ...initialTabsState(), homePath: 'C:\\Dir' });
  updatePane(store, getActiveSide(store.getState()), { path: 'C:\\Dir', entries: [], loading: false });
  const palette = new CommandPalette({ mount, store, bus: createEventBus() });
  palette.init();
  palette.open();
  palette._scope = 'content';
  return palette;
}

describe('CommandPalette — content search clears loading on empty results', () => {
  it('renders the empty state (not a stuck spinner) when nothing matches', async () => {
    const palette = openPalette();
    palette._query = '000';
    searchContent.mockResolvedValue([]); // no matches

    const update = vi.spyOn(palette, 'update');
    palette.runContentQuery();
    expect(palette._loading).toBe(true); // spinner shown while searching

    await tick(); // ensureContentIndexed -> searchContent -> commitResults

    expect(palette._loading).toBe(false);
    // The bug: commitResults skipped update() because the empty signature ('')
    // equalled the reset _lastSig (''), leaving the spinner up.
    expect(update).toHaveBeenCalled();
    // The result area now shows the "nothing found" message, not the loader.
    expect(palette._resultsEl.textContent).toContain(t('palette.empty'));
    expect(palette._resultsEl.textContent).not.toContain(t('common.loading'));
  });

  it('still de-dupes identical silent re-queries', async () => {
    const palette = openPalette();
    palette._query = 'hello';
    searchContent.mockResolvedValue([{ path: 'C:\\Dir\\a.txt', name: 'a.txt', snippet: 'hello' }]);

    palette.runContentQuery();
    await tick();
    const update = vi.spyOn(palette, 'update');
    palette.runContentQuery(true); // silent re-run, same results
    await tick();
    expect(update).not.toHaveBeenCalled();
  });
});
