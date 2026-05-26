import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

const OPENAI_STATE_DIR = '/home/node/.nanoclaw/openai';
const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';

interface OpenAIHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface OpenAIState {
  history: OpenAIHistoryTurn[];
}

function ensureStateDir(): void {
  fs.mkdirSync(OPENAI_STATE_DIR, { recursive: true });
}

function statePath(id: string): string {
  return path.join(OPENAI_STATE_DIR, `${id}.json`);
}

function loadState(id: string | undefined): { id: string; state: OpenAIState } {
  ensureStateDir();
  const stateId = id || `openai-${crypto.randomUUID()}`;
  if (!id || !fs.existsSync(statePath(stateId))) {
    return { id: stateId, state: { history: [] } };
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath(stateId), 'utf8')) as OpenAIState;
    return { id: stateId, state: { history: Array.isArray(state.history) ? state.history : [] } };
  } catch {
    return { id: stateId, state: { history: [] } };
  }
}

function saveState(id: string, state: OpenAIState): void {
  ensureStateDir();
  fs.writeFileSync(statePath(id), `${JSON.stringify(state, null, 2)}\n`);
}

function extractOutputText(payload: unknown): string {
  const response = payload as {
    output_text?: unknown;
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }>; text?: string }>;
  };
  if (typeof response.output_text === 'string') return response.output_text;

  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (typeof item.text === 'string') parts.push(item.text);
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function extractExplicitRcNamedTarget(prompt: string): string | null {
  const quotedMatch = prompt.match(/\b(?:in|from|with|for)\s+["“]([^"”]+)["”]\s*(?:team|chat|group)?(?=$|[\s?.!,])/i);
  if (quotedMatch?.[1]?.trim()) {
    return quotedMatch[1].trim();
  }

  const bracketedMatch = prompt.match(
    /\b(?:in|from|with|for)\s+(\[[^\]\n]+\](?:\s+(?!team\b|chat\b|group\b)[A-Za-z0-9&/_-]+){0,8})\s*(?:team|chat|group)?(?=$|[\s?.!,])/i,
  );
  if (bracketedMatch?.[1]?.trim()) {
    return bracketedMatch[1].trim();
  }

  return null;
}

export function shouldSkipHistoryForRcLookup(prompt: string, rcChat: boolean): boolean {
  if (!rcChat) return false;

  return (
    /!\[:(?:Team|Person)\]\(\d+\)/.test(prompt) ||
    !!extractExplicitRcNamedTarget(prompt) ||
    /\b(?:summarize|show|read|get|latest)\b[\s\S]{0,120}\b(?:message|messages)\b[\s\S]{0,120}\b(?:from|with)\b/i.test(
      prompt,
    ) ||
    /\brc[b]?:\d+\b/i.test(prompt)
  );
}

export function extractExplicitRcTarget(prompt: string): string | null {
  const mentionMatch = prompt.match(/!\[:(?:Team|Person)\]\((\d+)\)/i);
  if (mentionMatch) return mentionMatch[1];

  const jidMatch = prompt.match(/\brc[b]?:([0-9]+)\b/i);
  if (jidMatch) return jidMatch[1];

  const bareIdMatch = prompt.match(/\b(?:from|with|chat|team|id)\s+([0-9]{6,})\b/i);
  if (bareIdMatch) return bareIdMatch[1];

  const namedTarget = extractExplicitRcNamedTarget(prompt);
  if (namedTarget) return namedTarget;

  return null;
}

class OpenAIProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  constructor(private readonly options: ProviderOptions) {}

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const controller = new AbortController();
    let aborted = false;

    const events: AsyncIterable<ProviderEvent> = {
      [Symbol.asyncIterator]: async function* () {
        const { id, state } = loadState(input.continuation);
        yield { type: 'activity' };
        yield { type: 'init', continuation: id };

        state.history.push({ role: 'user', content: input.prompt });
        try {
          const text = await runOpenAIRequest(input, state.history, controller.signal);
          state.history.push({ role: 'assistant', content: text });
          saveState(id, { history: trimHistory(state.history) });
          if (!aborted) {
            yield { type: 'activity' };
            yield { type: 'result', text };
          }
        } catch (err) {
          if (aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          yield { type: 'error', message, retryable: /(?:429|500|502|503|504|timeout|network)/i.test(message) };
          throw err;
        }
      }.bind(this),
    };

    const runOpenAIRequest = async (
      queryInput: QueryInput,
      history: OpenAIHistoryTurn[],
      signal: AbortSignal,
    ): Promise<string> => {
      const env = this.options.env ?? {};
      const apiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY is required for provider "openai"');

      const baseUrl = (env.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
      const model =
        this.options.model ||
        env.AGENT_MODEL ||
        env.OPENAI_MODEL ||
        process.env.AGENT_MODEL ||
        process.env.OPENAI_MODEL ||
        DEFAULT_OPENAI_MODEL;

      const body: Record<string, unknown> = {
        model,
        input: history.map((turn) => ({ role: turn.role, content: turn.content })),
      };
      if (queryInput.systemContext?.instructions) {
        body.instructions = queryInput.systemContext.instructions;
      }
      if (this.options.effort) {
        body.reasoning = { effort: this.options.effort };
      }

      const resp = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!resp.ok) {
        throw new Error(`OpenAI request failed (${resp.status}): ${await resp.text()}`);
      }

      const payload = await resp.json();
      return extractOutputText(payload) || '';
    };

    return {
      push(_message: string) {
        // The OpenAI provider currently uses one request per poll-loop turn.
        // Follow-up messages are picked up by the outer loop after this stream
        // finishes, preserving v2's session continuation via the local state.
      },
      end() {
        // No persistent stream to end.
      },
      events,
      abort() {
        aborted = true;
        controller.abort();
      },
    };
  }
}

function trimHistory(history: OpenAIHistoryTurn[]): OpenAIHistoryTurn[] {
  return history.slice(-24);
}

registerProvider('openai', (options) => new OpenAIProvider(options));
