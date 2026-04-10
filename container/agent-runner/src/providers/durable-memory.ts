import fs from 'fs';
import path from 'path';

const FILES = [
  {
    name: 'MEMORY.md',
    label: 'Durable memory',
    maxChars: 2500,
  },
  {
    name: 'USER.md',
    label: 'Durable user preferences',
    maxChars: 2200,
  },
  {
    name: 'WORKING_MEMORY.md',
    label: 'Working memory snapshot',
    maxChars: 2600,
  },
] as const;

function readBoundedFile(filePath: string, maxChars: number): string | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return null;
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars).trimEnd()}\n\n[truncated]`;
}

export function loadDurableMemoryPromptSections(
  groupDir = '/workspace/group',
): string[] {
  const sections: string[] = [];

  for (const file of FILES) {
    const content = readBoundedFile(
      path.join(groupDir, file.name),
      file.maxChars,
    );
    if (!content) continue;
    sections.push(`${file.label}:\n${content}`);
  }

  return sections;
}
