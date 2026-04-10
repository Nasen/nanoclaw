import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseManagedEntries,
  upsertDurableMemoryFile,
} from './durable-memory.js';

const tempDirs: string[] = [];

function createTempFilePath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('upsertDurableMemoryFile', () => {
  it('creates a managed memory file and records a new entry', () => {
    const filePath = createTempFilePath('MEMORY.md');

    const result = upsertDurableMemoryFile({
      filePath,
      target: 'memory',
      title: 'Deploy rule',
      content: 'Rebuild the exact CONTAINER_IMAGE tag before restart.',
      timestamp: '2026-04-10T00:00:00.000Z',
    });

    const body = fs.readFileSync(filePath, 'utf-8');

    expect(result.updated).toBe(true);
    expect(body).toContain('# MEMORY');
    expect(body).toContain('<!-- nanoclaw-managed:start -->');
    expect(body).toContain(
      '**Deploy rule**: Rebuild the exact CONTAINER_IMAGE tag before restart.',
    );
  });

  it('skips duplicate entries with the same normalized title and content', () => {
    const filePath = createTempFilePath('USER.md');

    upsertDurableMemoryFile({
      filePath,
      target: 'user',
      title: 'Tone',
      content: 'Prefer concise updates in this group.',
      timestamp: '2026-04-10T00:00:00.000Z',
    });

    const result = upsertDurableMemoryFile({
      filePath,
      target: 'user',
      title: 'Tone',
      content: '  Prefer concise updates   in this group. ',
      timestamp: '2026-04-11T00:00:00.000Z',
    });

    const entries = parseManagedEntries(fs.readFileSync(filePath, 'utf-8'));

    expect(result.updated).toBe(false);
    expect(result.skippedDuplicate).toBe(true);
    expect(entries).toHaveLength(1);
  });

  it('keeps newest entries first and drops older entries when bounded size is exceeded', () => {
    const filePath = createTempFilePath('USER.md');

    for (let index = 0; index < 20; index += 1) {
      upsertDurableMemoryFile({
        filePath,
        target: 'user',
        title: `Preference ${index}`,
        content:
          'Use concise, stable wording for durable memory entries that should survive session resets.',
        timestamp: `2026-04-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      });
    }

    const body = fs.readFileSync(filePath, 'utf-8');
    const entries = parseManagedEntries(body);

    expect(entries.length).toBeLessThan(20);
    expect(entries[0].title).toBe('Preference 19');
    expect(body).not.toContain('Preference 0');
  });
});
