import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildWorkingMemoryDocument,
  updateWorkingMemoryFile,
} from './working-memory.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-working-memory-'),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildWorkingMemoryDocument', () => {
  it('renders a bounded working memory snapshot with summary and recent turns', () => {
    const document = buildWorkingMemoryDocument({
      summary:
        'Investigating rollout failures and recent deployment constraints.',
      turns: [
        {
          role: 'user',
          content: 'The deploy step failed after the image swap.',
        },
        {
          role: 'assistant',
          content:
            'I traced it to a stale image tag and a missing restart instruction in the runbook.',
        },
      ],
      updatedAt: '2026-04-10T10:00:00.000Z',
    });

    expect(document).toContain('# WORKING MEMORY');
    expect(document).toContain('## Session Summary');
    expect(document).toContain('Investigating rollout failures');
    expect(document).toContain(
      '- User: The deploy step failed after the image swap.',
    );
  });
});

describe('updateWorkingMemoryFile', () => {
  it('writes WORKING_MEMORY.md to disk', () => {
    const dir = createTempDir();
    const filePath = path.join(dir, 'WORKING_MEMORY.md');

    updateWorkingMemoryFile({
      filePath,
      turns: [{ role: 'user', content: 'Need a compact session summary.' }],
    });

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toContain(
      'Need a compact session summary.',
    );
  });
});
