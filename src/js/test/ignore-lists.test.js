import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALWAYS_IGNORE_DIRS } from '../components/relationship-graph/constants.js';

// The graph (JS) and the indexer (Rust) must skip the same folders.
describe('ignored folder lists', () => {
  it('match between the frontend and the backend', () => {
    // vitest runs from the repository root (vitest.config.js lives there).
    const rs = readFileSync(resolve(process.cwd(), 'src-tauri/src/index/text_detect.rs'), 'utf8');
    const block = rs.match(/pub const IGNORED_DIRS: &\[&str\] = &\[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const rust = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect([...ALWAYS_IGNORE_DIRS].sort()).toEqual(rust);
  });
});
