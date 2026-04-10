import fs from 'fs';
import path from 'path';

import { deleteGroupDocumentsExcept, upsertGroupDocument } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';

export type IndexedGroupDocumentType =
  | 'memory'
  | 'user'
  | 'working_memory'
  | 'runbook'
  | 'skill_candidate'
  | 'conversation';

interface IndexedGroupDocumentInput {
  absolutePath: string;
  groupFolder: string;
  docType: IndexedGroupDocumentType;
}

function getFirstHeading(markdown: string): string | null {
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#')) continue;
    return trimmed.replace(/^#+\s*/, '').trim() || null;
  }
  return null;
}

function normalizeDocTitle(filePath: string, content: string): string {
  return (
    getFirstHeading(content) || path.basename(filePath, path.extname(filePath))
  );
}

function readBoundedDocument(filePath: string, maxChars = 12000): string {
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars).trimEnd()}\n\n[truncated]`;
}

function buildGroupDocument(
  input: IndexedGroupDocumentInput,
): Parameters<typeof upsertGroupDocument>[0] {
  const stat = fs.statSync(input.absolutePath);
  const content = readBoundedDocument(input.absolutePath);
  return {
    path: input.absolutePath,
    group_folder: input.groupFolder,
    doc_type: input.docType,
    title: normalizeDocTitle(input.absolutePath, content),
    content,
    updated_at: stat.mtime.toISOString(),
    mtime_ms: stat.mtimeMs,
  };
}

function collectMarkdownFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];

  const collected: string[] = [];
  const visit = (currentDir: string) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.toLowerCase().endsWith('.md')) {
        collected.push(fullPath);
      }
    }
  };

  visit(rootDir);
  return collected.sort();
}

export function syncGroupDocumentIndex(groupFolder: string): void {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const docs: IndexedGroupDocumentInput[] = [];

  const pushIfExists = (
    relativePath: string,
    docType: IndexedGroupDocumentType,
  ) => {
    const absolutePath = path.join(groupDir, relativePath);
    if (!fs.existsSync(absolutePath)) return;
    docs.push({ absolutePath, groupFolder, docType });
  };

  pushIfExists('MEMORY.md', 'memory');
  pushIfExists('USER.md', 'user');
  pushIfExists('WORKING_MEMORY.md', 'working_memory');

  const runbooksDir = path.join(groupDir, 'runbooks');
  for (const absolutePath of collectMarkdownFiles(runbooksDir)) {
    const relativePath = path.relative(runbooksDir, absolutePath);
    if (relativePath === 'index.md') continue;
    const docType = relativePath.startsWith(`skill-candidates${path.sep}`)
      ? 'skill_candidate'
      : 'runbook';
    docs.push({ absolutePath, groupFolder, docType });
  }

  const conversationsDir = path.join(groupDir, 'conversations');
  for (const absolutePath of collectMarkdownFiles(conversationsDir)) {
    docs.push({ absolutePath, groupFolder, docType: 'conversation' });
  }

  for (const doc of docs) {
    upsertGroupDocument(buildGroupDocument(doc));
  }

  deleteGroupDocumentsExcept(
    groupFolder,
    docs.map((doc) => doc.absolutePath),
  );
}
