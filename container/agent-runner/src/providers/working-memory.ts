import fs from 'fs';
import path from 'path';

export interface WorkingMemoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_SUMMARY_CHARS = 600;
const MAX_TURN_CHARS = 280;
const MAX_RENDERED_CHARS = 2400;
const MAX_RECENT_TURNS = 8;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function toRecentTurnLines(turns: WorkingMemoryTurn[]): string[] {
  const lines: string[] = [];

  for (const turn of turns.slice(-MAX_RECENT_TURNS)) {
    const content = truncate(normalizeWhitespace(turn.content), MAX_TURN_CHARS);
    if (!content) continue;
    const label = turn.role === 'user' ? 'User' : 'Assistant';
    lines.push(`- ${label}: ${content}`);
  }

  return lines;
}

export function buildWorkingMemoryDocument(params: {
  summary?: string | null;
  turns: WorkingMemoryTurn[];
  updatedAt?: string;
}): string {
  const updatedAt = params.updatedAt || new Date().toISOString();
  const summary = params.summary
    ? truncate(normalizeWhitespace(params.summary), MAX_SUMMARY_CHARS)
    : '';
  const recentTurnLines = toRecentTurnLines(params.turns);

  const sections: string[] = [
    '# WORKING MEMORY',
    '',
    'Short-lived working memory snapshot for this group. Prefer recent facts, active tasks, and current constraints over long-term policy.',
    '',
    `Updated: ${updatedAt}`,
  ];

  if (summary) {
    sections.push('', '## Session Summary', '', summary);
  }

  if (recentTurnLines.length > 0) {
    sections.push('', '## Recent Turns', '', ...recentTurnLines);
  }

  let rendered = `${sections.join('\n').trimEnd()}\n`;
  if (rendered.length <= MAX_RENDERED_CHARS) return rendered;

  const trimmedTurns = recentTurnLines.slice(
    -Math.max(2, Math.floor(MAX_RECENT_TURNS / 2)),
  );
  const fallbackSections = [
    '# WORKING MEMORY',
    '',
    'Short-lived working memory snapshot for this group.',
    '',
    `Updated: ${updatedAt}`,
    summary ? '' : null,
    summary ? '## Session Summary' : null,
    summary ? '' : null,
    summary || null,
    trimmedTurns.length > 0 ? '' : null,
    trimmedTurns.length > 0 ? '## Recent Turns' : null,
    trimmedTurns.length > 0 ? '' : null,
    ...trimmedTurns,
  ].filter((line): line is string => line !== null);

  rendered = `${fallbackSections.join('\n').trimEnd()}\n`;
  return truncate(rendered, MAX_RENDERED_CHARS);
}

export function updateWorkingMemoryFile(params: {
  filePath?: string;
  summary?: string | null;
  turns: WorkingMemoryTurn[];
  updatedAt?: string;
}): string {
  const filePath = params.filePath || '/workspace/group/WORKING_MEMORY.md';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const document = buildWorkingMemoryDocument(params);
  fs.writeFileSync(filePath, document, 'utf-8');
  return filePath;
}
