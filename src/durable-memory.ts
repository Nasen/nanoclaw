import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';

export type DurableMemoryTarget = 'memory' | 'user';

export interface DurableMemoryEntry {
  timestamp: string;
  title?: string;
  content: string;
}

interface DurableMemoryTargetConfig {
  fileName: string;
  heading: string;
  description: string;
  maxChars: number;
  maxEntries: number;
  maxTitleChars: number;
  maxContentChars: number;
}

export interface UpsertDurableMemoryResult {
  filePath: string;
  fileName: string;
  target: DurableMemoryTarget;
  updated: boolean;
  skippedDuplicate: boolean;
  entryCount: number;
  droppedEntries: number;
}

const MANAGED_START = '<!-- nanoclaw-managed:start -->';
const MANAGED_END = '<!-- nanoclaw-managed:end -->';

const TARGET_CONFIG: Record<DurableMemoryTarget, DurableMemoryTargetConfig> = {
  memory: {
    fileName: 'MEMORY.md',
    heading: 'MEMORY',
    description:
      'Bounded durable memory for this group. Keep entries stable, concise, and reusable.',
    maxChars: 2200,
    maxEntries: 24,
    maxTitleChars: 80,
    maxContentChars: 320,
  },
  user: {
    fileName: 'USER.md',
    heading: 'USER',
    description:
      'Bounded user preferences for this group. Keep entries stable, concise, and behavior-shaping.',
    maxChars: 1800,
    maxEntries: 16,
    maxTitleChars: 80,
    maxContentChars: 260,
  },
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeEntry(
  entry: Pick<DurableMemoryEntry, 'timestamp' | 'title' | 'content'>,
  target: DurableMemoryTarget,
): DurableMemoryEntry {
  const config = TARGET_CONFIG[target];
  const title = entry.title ? normalizeWhitespace(entry.title) : undefined;
  const content = normalizeWhitespace(entry.content);

  return {
    timestamp: entry.timestamp,
    title:
      title && title.length > 0
        ? truncate(title, config.maxTitleChars)
        : undefined,
    content: truncate(content, config.maxContentChars),
  };
}

function entryDeduplicationKey(entry: DurableMemoryEntry): string {
  return `${entry.title || ''}::${entry.content}`.toLowerCase();
}

function formatEntry(entry: DurableMemoryEntry): string {
  const titlePrefix = entry.title ? `**${entry.title}**: ` : '';
  return `- [${entry.timestamp}] ${titlePrefix}${entry.content}`;
}

function buildManagedBlock(
  target: DurableMemoryTarget,
  entries: DurableMemoryEntry[],
): string {
  const config = TARGET_CONFIG[target];
  const lines = entries.map((entry) => formatEntry(entry));
  return [
    `## Managed ${config.heading} Entries`,
    '',
    MANAGED_START,
    ...lines,
    MANAGED_END,
  ].join('\n');
}

function buildInitialFile(
  target: DurableMemoryTarget,
  entries: DurableMemoryEntry[],
): string {
  const config = TARGET_CONFIG[target];
  return [
    `# ${config.heading}`,
    '',
    config.description,
    '',
    buildManagedBlock(target, entries),
    '',
  ].join('\n');
}

function ensureManagedBlock(body: string, target: DurableMemoryTarget): string {
  if (body.includes(MANAGED_START) && body.includes(MANAGED_END)) return body;

  const trimmed = body.trimEnd();
  const managedBlock = buildManagedBlock(target, []);
  if (!trimmed) return buildInitialFile(target, []);

  return `${trimmed}\n\n${managedBlock}\n`;
}

function replaceManagedEntries(
  body: string,
  target: DurableMemoryTarget,
  entries: DurableMemoryEntry[],
): string {
  const withBlock = ensureManagedBlock(body, target);
  const start = withBlock.indexOf(MANAGED_START);
  const end = withBlock.indexOf(MANAGED_END);

  if (start === -1 || end === -1 || end < start) {
    throw new Error('Managed durable memory block is malformed.');
  }

  const before = withBlock.slice(0, start + MANAGED_START.length);
  const after = withBlock.slice(end);
  const renderedEntries = entries.map((entry) => formatEntry(entry)).join('\n');

  return `${before}\n${renderedEntries ? `${renderedEntries}\n` : ''}${after}`;
}

function extractManagedRegion(body: string): string {
  const start = body.indexOf(MANAGED_START);
  const end = body.indexOf(MANAGED_END);
  if (start === -1 || end === -1 || end < start) return '';
  return body
    .slice(start + MANAGED_START.length, end)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

export function parseManagedEntries(body: string): DurableMemoryEntry[] {
  const region = extractManagedRegion(body);
  if (!region) return [];

  const entries: DurableMemoryEntry[] = [];
  const pattern =
    /^- \[(?<timestamp>[^\]]+)\] (?:(?:\*\*(?<title>[^*]+)\*\*): )?(?<content>.+)$/;

  for (const line of region.split('\n')) {
    const match = line.match(pattern);
    if (!match?.groups?.timestamp || !match.groups.content) continue;
    entries.push({
      timestamp: match.groups.timestamp,
      title: match.groups.title,
      content: match.groups.content,
    });
  }

  return entries;
}

function boundEntries(
  target: DurableMemoryTarget,
  entries: DurableMemoryEntry[],
): { kept: DurableMemoryEntry[]; droppedEntries: number } {
  const config = TARGET_CONFIG[target];
  const kept: DurableMemoryEntry[] = [];
  let totalChars = 0;

  for (const entry of entries) {
    if (kept.length >= config.maxEntries) break;
    const rendered = formatEntry(entry);
    const nextTotal = totalChars + rendered.length + 1;
    if (kept.length > 0 && nextTotal > config.maxChars) break;
    kept.push(entry);
    totalChars = nextTotal;
  }

  return {
    kept,
    droppedEntries: Math.max(0, entries.length - kept.length),
  };
}

export function upsertDurableMemoryFile(params: {
  filePath: string;
  target: DurableMemoryTarget;
  title?: string;
  content: string;
  timestamp?: string;
}): UpsertDurableMemoryResult {
  const timestamp = params.timestamp || new Date().toISOString();
  const normalizedEntry = normalizeEntry(
    {
      timestamp,
      title: params.title,
      content: params.content,
    },
    params.target,
  );

  if (!normalizedEntry.content) {
    throw new Error('Durable memory content cannot be empty.');
  }

  fs.mkdirSync(path.dirname(params.filePath), { recursive: true });

  const existingBody = fs.existsSync(params.filePath)
    ? fs.readFileSync(params.filePath, 'utf-8')
    : buildInitialFile(params.target, []);

  const existingEntries = parseManagedEntries(existingBody);
  const dedupeKey = entryDeduplicationKey(normalizedEntry);
  const skippedDuplicate = existingEntries.some(
    (entry) => entryDeduplicationKey(entry) === dedupeKey,
  );

  if (skippedDuplicate) {
    return {
      filePath: params.filePath,
      fileName: TARGET_CONFIG[params.target].fileName,
      target: params.target,
      updated: false,
      skippedDuplicate: true,
      entryCount: existingEntries.length,
      droppedEntries: 0,
    };
  }

  const bounded = boundEntries(params.target, [
    normalizedEntry,
    ...existingEntries,
  ]);
  const nextBody = replaceManagedEntries(
    existingBody,
    params.target,
    bounded.kept,
  );
  fs.writeFileSync(params.filePath, `${nextBody.trimEnd()}\n`, 'utf-8');

  return {
    filePath: params.filePath,
    fileName: TARGET_CONFIG[params.target].fileName,
    target: params.target,
    updated: true,
    skippedDuplicate: false,
    entryCount: bounded.kept.length,
    droppedEntries: bounded.droppedEntries,
  };
}

export function upsertGroupDurableMemory(params: {
  groupFolder: string;
  target: DurableMemoryTarget;
  title?: string;
  content: string;
  timestamp?: string;
}): UpsertDurableMemoryResult {
  const groupDir = resolveGroupFolderPath(params.groupFolder);
  const fileName = TARGET_CONFIG[params.target].fileName;
  const filePath = path.join(groupDir, fileName);

  return upsertDurableMemoryFile({
    filePath,
    target: params.target,
    title: params.title,
    content: params.content,
    timestamp: params.timestamp,
  });
}
