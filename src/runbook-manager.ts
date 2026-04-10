import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';

export type RunbookKind = 'runbook' | 'skill_candidate';

export interface UpsertRunbookResult {
  filePath: string;
  relativePath: string;
  indexPath: string;
  updated: boolean;
}

export interface PromoteRunbookResult {
  sourcePath: string;
  sourceRelativePath: string;
  filePath: string;
  relativePath: string;
  indexPath: string;
  updated: boolean;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'untitled';
}

function upsertIndexEntry(
  indexPath: string,
  relativePath: string,
  title: string,
  summary?: string,
): void {
  const bullet = `- \`${relativePath}\`: ${summary?.trim() || title}`;
  const existing = fs.existsSync(indexPath)
    ? fs.readFileSync(indexPath, 'utf-8')
    : '# Runbooks\n\n';
  const lines = existing
    .split('\n')
    .filter((line) => !line.includes(`\`${relativePath}\``));
  const next = `${lines.join('\n').trimEnd()}\n\n${bullet}\n`;
  fs.writeFileSync(indexPath, next, 'utf-8');
}

function removeIndexEntry(indexPath: string, relativePath: string): void {
  if (!fs.existsSync(indexPath)) return;
  const next = fs
    .readFileSync(indexPath, 'utf-8')
    .split('\n')
    .filter((line) => !line.includes(`\`${relativePath}\``))
    .join('\n')
    .trimEnd();
  fs.writeFileSync(indexPath, `${next}\n`, 'utf-8');
}

function resolveRunbookPaths(
  groupFolder: string,
  kind: RunbookKind,
  title: string,
  slugInput?: string,
): {
  runbooksDir: string;
  baseDir: string;
  filePath: string;
  relativePath: string;
  indexPath: string;
} {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const runbooksDir = path.join(groupDir, 'runbooks');
  const baseDir =
    kind === 'skill_candidate'
      ? path.join(runbooksDir, 'skill-candidates')
      : runbooksDir;
  const slug = slugify(slugInput || title);
  const fileName = `${slug}.md`;
  const filePath = path.join(baseDir, fileName);
  const relativePath =
    kind === 'skill_candidate'
      ? path.join('skill-candidates', fileName)
      : fileName;
  const indexPath = path.join(runbooksDir, 'index.md');
  return {
    runbooksDir,
    baseDir,
    filePath,
    relativePath,
    indexPath,
  };
}

function normalizeCandidateRelativePath(candidatePath: string): string {
  const normalized = candidatePath.replace(/\\/g, '/').trim();
  const withoutPrefix = normalized.startsWith('skill-candidates/')
    ? normalized.slice('skill-candidates/'.length)
    : path.posix.basename(normalized);
  const normalizedRelative = path.posix.normalize(withoutPrefix);
  if (
    !normalizedRelative ||
    normalizedRelative === '.' ||
    normalizedRelative.startsWith('../') ||
    normalizedRelative.includes('/../') ||
    path.posix.isAbsolute(normalizedRelative)
  ) {
    throw new Error(`Invalid skill candidate path: ${candidatePath}`);
  }
  return path.posix.join('skill-candidates', normalizedRelative);
}

function resolveSkillCandidateSource(params: {
  groupFolder: string;
  candidatePath: string;
}): {
  sourceRelativePath: string;
  sourcePath: string;
} {
  const groupDir = resolveGroupFolderPath(params.groupFolder);
  const skillCandidatesDir = path.join(
    groupDir,
    'runbooks',
    'skill-candidates',
  );
  const sourceRelativePath = normalizeCandidateRelativePath(
    params.candidatePath,
  );
  const candidateRelativePath = sourceRelativePath.slice(
    'skill-candidates/'.length,
  );
  const sourcePath = path.resolve(skillCandidatesDir, candidateRelativePath);
  const relativeCheck = path.relative(skillCandidatesDir, sourcePath);

  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
    throw new Error(`Invalid skill candidate path: ${params.candidatePath}`);
  }

  return {
    sourceRelativePath,
    sourcePath,
  };
}

function parseRunbookMarkdown(content: string): {
  title: string | null;
  summary: string | null;
  body: string;
} {
  const trimmed = content.trim();
  const titleMatch = trimmed.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim() || null;

  const withoutHeading = trimmed.replace(/^#\s+.+\n*/m, '').trim();
  if (!withoutHeading) {
    return { title, summary: null, body: '' };
  }

  const paragraphs = withoutHeading
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length >= 2) {
    return {
      title,
      summary: paragraphs[0],
      body: paragraphs.slice(1).join('\n\n'),
    };
  }

  return {
    title,
    summary: null,
    body: withoutHeading,
  };
}

export function upsertGroupRunbook(params: {
  groupFolder: string;
  kind: RunbookKind;
  title: string;
  body: string;
  summary?: string;
  slug?: string;
}): UpsertRunbookResult {
  const title = params.title.trim();
  const body = params.body.trim();
  if (!title) throw new Error('Runbook title cannot be empty.');
  if (!body) throw new Error('Runbook body cannot be empty.');

  const { runbooksDir, baseDir, filePath, relativePath, indexPath } =
    resolveRunbookPaths(params.groupFolder, params.kind, title, params.slug);

  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(runbooksDir, { recursive: true });

  const content = [
    `# ${title}`,
    '',
    params.summary?.trim() ? params.summary.trim() : null,
    params.summary?.trim() ? '' : null,
    body,
    '',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  const previous = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : null;
  const updated = previous !== content;
  fs.writeFileSync(filePath, content, 'utf-8');

  upsertIndexEntry(indexPath, relativePath, title, params.summary);

  return {
    filePath,
    relativePath,
    indexPath,
    updated,
  };
}

export function promoteSkillCandidateToRunbook(params: {
  groupFolder: string;
  candidatePath: string;
  title?: string;
  summary?: string;
  slug?: string;
}): PromoteRunbookResult {
  const { sourceRelativePath, sourcePath } = resolveSkillCandidateSource({
    groupFolder: params.groupFolder,
    candidatePath: params.candidatePath,
  });
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Skill candidate not found: ${sourceRelativePath}`);
  }

  const sourceBody = fs.readFileSync(sourcePath, 'utf-8').trim();
  const parsedCandidate = parseRunbookMarkdown(sourceBody);
  const resolvedTitle = (params.title || parsedCandidate.title || '').trim();
  if (!resolvedTitle) {
    throw new Error('Promoted runbook title cannot be empty.');
  }

  const nextRunbook = upsertGroupRunbook({
    groupFolder: params.groupFolder,
    kind: 'runbook',
    title: resolvedTitle,
    body: parsedCandidate.body,
    summary: params.summary ?? parsedCandidate.summary ?? undefined,
    slug: params.slug,
  });

  fs.rmSync(sourcePath, { force: true });
  removeIndexEntry(nextRunbook.indexPath, sourceRelativePath);

  return {
    sourcePath,
    sourceRelativePath,
    filePath: nextRunbook.filePath,
    relativePath: nextRunbook.relativePath,
    indexPath: nextRunbook.indexPath,
    updated: nextRunbook.updated,
  };
}
