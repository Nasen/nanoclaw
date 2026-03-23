import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath } from './group-folder.js';

export interface NotebookLmConfig {
  projectNumber: string;
  location: string;
  endpointLocation: string;
  baseUrl?: string;
}

export interface NotebookLmNotebook {
  title: string;
  notebookId: string;
  emoji?: string;
  metadata?: Record<string, unknown>;
  name?: string;
  sources?: NotebookLmSource[];
}

export interface NotebookLmSource {
  sourceId?: { id: string };
  title?: string;
  metadata?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  name?: string;
}

export type NotebookLmSourceInput =
  | {
      type: 'text';
      text: string;
      title?: string;
    }
  | {
      type: 'web';
      url: string;
      title?: string;
    }
  | {
      type: 'file';
      path: string;
      title?: string;
      contentType?: string;
    };

export interface NotebookLmAddSourcesResult {
  createdSources: NotebookLmSource[];
  uploadedFiles: Array<{
    sourceId?: { id: string };
    title: string;
    path: string;
  }>;
}

interface NotebookLmClientDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => string;
}

const NOTEBOOKLM_ENV_KEYS = [
  'NOTEBOOKLM_PROJECT_NUMBER',
  'NOTEBOOKLM_LOCATION',
  'NOTEBOOKLM_ENDPOINT_LOCATION',
  'NOTEBOOKLM_BASE_URL',
] as const;

const FILE_CONTENT_TYPES: Record<string, string> = {
  '.3g2': 'audio/3gpp2',
  '.3gp': 'audio/3gpp',
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aifc': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.amr': 'audio/amr',
  '.au': 'audio/basic',
  '.avi': 'video/x-msvideo',
  '.cda': 'application/x-cdf',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpg',
  '.m4a': 'audio/m4a',
  '.md': 'text/markdown',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mpeg': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ra': 'audio/vnd.rn-realaudio',
  '.ram': 'audio/vnd.rn-realaudio',
  '.snd': 'audio/basic',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.weba': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function readNotebookLmEnv(): Record<string, string> {
  return readEnvFile([...NOTEBOOKLM_ENV_KEYS]);
}

export function isNotebookLmConfigured(): boolean {
  const env = readNotebookLmEnv();
  return Boolean(
    process.env.NOTEBOOKLM_PROJECT_NUMBER || env.NOTEBOOKLM_PROJECT_NUMBER,
  );
}

export function getNotebookLmConfig(): NotebookLmConfig {
  const env = readNotebookLmEnv();
  const projectNumber =
    process.env.NOTEBOOKLM_PROJECT_NUMBER || env.NOTEBOOKLM_PROJECT_NUMBER;

  if (!projectNumber) {
    throw new Error(
      'NotebookLM is not configured. Set NOTEBOOKLM_PROJECT_NUMBER in .env.',
    );
  }

  const location =
    process.env.NOTEBOOKLM_LOCATION || env.NOTEBOOKLM_LOCATION || 'global';
  const endpointLocation =
    process.env.NOTEBOOKLM_ENDPOINT_LOCATION ||
    env.NOTEBOOKLM_ENDPOINT_LOCATION ||
    location;
  const baseUrl =
    process.env.NOTEBOOKLM_BASE_URL || env.NOTEBOOKLM_BASE_URL || undefined;

  return {
    projectNumber,
    location,
    endpointLocation,
    baseUrl,
  };
}

export function getNotebookLmAccessToken(): string {
  try {
    const token = execFileSync('gcloud', ['auth', 'print-access-token'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    if (!token) {
      throw new Error('Empty access token returned by gcloud');
    }

    return token;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `NotebookLM auth failed. Run "gcloud auth login" and ensure NotebookLM Enterprise access is enabled. ${message}`,
    );
  }
}

function getApiRoot(config: NotebookLmConfig, upload = false): string {
  const normalizedBase = config.baseUrl?.replace(/\/$/, '');
  if (normalizedBase) {
    if (normalizedBase.endsWith('/upload/v1alpha')) {
      return upload
        ? normalizedBase
        : normalizedBase.replace(/\/upload\/v1alpha$/, '/v1alpha');
    }
    if (normalizedBase.endsWith('/v1alpha')) {
      return upload
        ? normalizedBase.replace(/\/v1alpha$/, '/upload/v1alpha')
        : normalizedBase;
    }
    return `${normalizedBase}${upload ? '/upload' : ''}/v1alpha`;
  }

  return `https://${config.endpointLocation}-discoveryengine.googleapis.com${upload ? '/upload' : ''}/v1alpha`;
}

function notebookResourcePath(
  config: NotebookLmConfig,
  notebookId?: string,
): string {
  const base = `/projects/${config.projectNumber}/locations/${config.location}/notebooks`;
  return notebookId ? `${base}/${notebookId}` : base;
}

function describeNotebookLmError(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string };
      message?: string;
    };
    const message = parsed.error?.message || parsed.message;
    if (message) return `NotebookLM API ${status}: ${message}`;
  } catch {
    // Fall through to raw text handling.
  }

  const trimmed = text.trim();
  return trimmed
    ? `NotebookLM API ${status}: ${trimmed}`
    : `NotebookLM API ${status}`;
}

function normalizeSourceTitle(source: NotebookLmSourceInput): string {
  if (source.title?.trim()) return source.title.trim();

  if (source.type === 'text') {
    const firstLine = source.text.split('\n')[0]?.trim();
    return firstLine ? firstLine.slice(0, 80) : 'NanoClaw text source';
  }

  if (source.type === 'web') {
    return source.url;
  }

  return path.basename(source.path);
}

export function inferNotebookLmContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = FILE_CONTENT_TYPES[extension];
  if (!contentType) {
    throw new Error(
      `Unsupported file type "${extension || '(none)'}". Provide contentType explicitly or use a supported NotebookLM format.`,
    );
  }
  return contentType;
}

export function resolveNotebookLmFilePath(
  filePath: string,
  sourceGroup: string,
  isMain: boolean,
): string {
  const groupRoot = fs.realpathSync(resolveGroupFolderPath(sourceGroup));
  const globalRoot = fs.existsSync(path.join(GROUPS_DIR, 'global'))
    ? fs.realpathSync(path.join(GROUPS_DIR, 'global'))
    : null;
  const repoRoot = isMain ? fs.realpathSync(process.cwd()) : null;

  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(groupRoot, filePath);

  let realPath: string;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = fs.statSync(realPath);
  if (!stat.isFile()) {
    throw new Error(`NotebookLM file source must be a file: ${filePath}`);
  }

  const allowedRoots = [groupRoot, globalRoot, repoRoot].filter(
    (value): value is string => Boolean(value),
  );
  const isAllowed = allowedRoots.some((root) => {
    const relative = path.relative(root, realPath);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  });

  if (!isAllowed) {
    throw new Error(
      `File path is outside NotebookLM allowed roots for this group: ${filePath}`,
    );
  }

  return realPath;
}

export class NotebookLmClient {
  private readonly fetchImpl: typeof fetch;
  private readonly getAccessToken: () => string;

  constructor(
    private readonly config: NotebookLmConfig,
    deps: NotebookLmClientDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl || fetch;
    this.getAccessToken = deps.getAccessToken || getNotebookLmAccessToken;
  }

  private async request<T>(
    method: string,
    resourcePath: string,
    init: {
      body?: string | Buffer;
      headers?: Record<string, string>;
      upload?: boolean;
    } = {},
  ): Promise<T> {
    const token = this.getAccessToken();
    const response = await this.fetchImpl(
      `${getApiRoot(this.config, init.upload)}${resourcePath}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...init.headers,
        },
        body: init.body,
      },
    );

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(describeNotebookLmError(response.status, responseText));
    }

    if (!responseText.trim()) {
      return {} as T;
    }

    return JSON.parse(responseText) as T;
  }

  async listNotebooks(limit = 20): Promise<NotebookLmNotebook[]> {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const query = new URLSearchParams({ pageSize: String(pageSize) });
    const payload = await this.request<{ notebooks?: NotebookLmNotebook[] }>(
      'GET',
      `${notebookResourcePath(this.config)}:listRecentlyViewed?${query.toString()}`,
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
    return payload.notebooks || [];
  }

  async createNotebook(title: string): Promise<NotebookLmNotebook> {
    return this.request<NotebookLmNotebook>(
      'POST',
      notebookResourcePath(this.config),
      {
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title }),
      },
    );
  }

  async getNotebook(notebookId: string): Promise<NotebookLmNotebook> {
    return this.request<NotebookLmNotebook>(
      'GET',
      notebookResourcePath(this.config, notebookId),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
  }

  async batchCreateSources(
    notebookId: string,
    userContents: Array<Record<string, unknown>>,
  ): Promise<NotebookLmSource[]> {
    const payload = await this.request<{ sources?: NotebookLmSource[] }>(
      'POST',
      `${notebookResourcePath(this.config, notebookId)}/sources:batchCreate`,
      {
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userContents }),
      },
    );
    return payload.sources || [];
  }

  async uploadFileSource(
    notebookId: string,
    filePath: string,
    displayName: string,
    contentType: string,
  ): Promise<{ sourceId?: { id: string } }> {
    return this.request<{ sourceId?: { id: string } }>(
      'POST',
      `${notebookResourcePath(this.config, notebookId)}/sources:uploadFile`,
      {
        upload: true,
        headers: {
          'Content-Type': contentType,
          'X-Goog-Upload-File-Name': displayName,
          'X-Goog-Upload-Protocol': 'raw',
        },
        body: fs.readFileSync(filePath),
      },
    );
  }
}

export function createNotebookLmClient(
  config = getNotebookLmConfig(),
  deps: NotebookLmClientDeps = {},
): NotebookLmClient {
  return new NotebookLmClient(config, deps);
}

export async function addNotebookLmSources(
  notebookId: string,
  sources: NotebookLmSourceInput[],
  sourceGroup: string,
  isMain: boolean,
  client = createNotebookLmClient(),
): Promise<NotebookLmAddSourcesResult> {
  const createdSources: NotebookLmSource[] = [];
  const uploadedFiles: NotebookLmAddSourcesResult['uploadedFiles'] = [];

  const batchSources = sources
    .filter((source) => source.type !== 'file')
    .map((source) => {
      const title = normalizeSourceTitle(source);
      if (source.type === 'text') {
        return {
          textContent: {
            sourceName: title,
            content: source.text,
          },
        };
      }
      return {
        webContent: {
          sourceName: title,
          url: source.url,
        },
      };
    });

  if (batchSources.length > 0) {
    createdSources.push(
      ...(await client.batchCreateSources(notebookId, batchSources)),
    );
  }

  for (const source of sources) {
    if (source.type !== 'file') continue;

    const resolvedPath = resolveNotebookLmFilePath(
      source.path,
      sourceGroup,
      isMain,
    );
    const title = normalizeSourceTitle(source);
    const contentType =
      source.contentType || inferNotebookLmContentType(resolvedPath);
    const result = await client.uploadFileSource(
      notebookId,
      resolvedPath,
      title,
      contentType,
    );
    uploadedFiles.push({
      sourceId: result.sourceId,
      title,
      path: resolvedPath,
    });
  }

  return {
    createdSources,
    uploadedFiles,
  };
}
