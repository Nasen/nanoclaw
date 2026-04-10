import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadDurableMemoryPromptSections } from './durable-memory.js';

const tempDirs: string[] = [];

function createTempGroupDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-provider-memory-'),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadDurableMemoryPromptSections', () => {
  it('loads MEMORY.md, USER.md, and WORKING_MEMORY.md as separate prompt sections', () => {
    const dir = createTempGroupDir();
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# MEMORY\n\nGroup fact');
    fs.writeFileSync(path.join(dir, 'USER.md'), '# USER\n\nUser preference');
    fs.writeFileSync(
      path.join(dir, 'WORKING_MEMORY.md'),
      '# WORKING MEMORY\n\nRecent focus',
    );

    const sections = loadDurableMemoryPromptSections(dir);

    expect(sections).toEqual([
      'Durable memory:\n# MEMORY\n\nGroup fact',
      'Durable user preferences:\n# USER\n\nUser preference',
      'Working memory snapshot:\n# WORKING MEMORY\n\nRecent focus',
    ]);
  });

  it('returns no sections when durable memory files are absent', () => {
    expect(loadDurableMemoryPromptSections(createTempGroupDir())).toEqual([]);
  });
});
