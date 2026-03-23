import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NotebookLmClient,
  addNotebookLmSources,
  getNotebookLmConfig,
  inferNotebookLmContentType,
  resolveNotebookLmFilePath,
} from './notebooklm.js';

describe('notebooklm config', () => {
  afterEach(() => {
    delete process.env.NOTEBOOKLM_PROJECT_NUMBER;
    delete process.env.NOTEBOOKLM_LOCATION;
    delete process.env.NOTEBOOKLM_ENDPOINT_LOCATION;
    delete process.env.NOTEBOOKLM_BASE_URL;
  });

  it('loads project number and defaults locations to global', () => {
    process.env.NOTEBOOKLM_PROJECT_NUMBER = '123456789012';

    expect(getNotebookLmConfig()).toEqual({
      projectNumber: '123456789012',
      location: 'global',
      endpointLocation: 'global',
      baseUrl: undefined,
    });
  });

  it('throws when NotebookLM is not configured', () => {
    expect(() => getNotebookLmConfig()).toThrow(/NOTEBOOKLM_PROJECT_NUMBER/);
  });
});

describe('NotebookLmClient', () => {
  it('builds listRecentlyViewed requests correctly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          notebooks: [{ notebookId: 'nb-1', title: 'Notebook 1' }],
        }),
    });

    const client = new NotebookLmClient(
      {
        projectNumber: '123456789012',
        location: 'global',
        endpointLocation: 'us',
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getAccessToken: () => 'test-token',
      },
    );

    const notebooks = await client.listNotebooks(12);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://us-discoveryengine.googleapis.com/v1alpha/projects/123456789012/locations/global/notebooks:listRecentlyViewed?pageSize=12',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(notebooks).toEqual([{ notebookId: 'nb-1', title: 'Notebook 1' }]);
  });

  it('uploads files using the upload endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sourceId: { id: 'src-1' } }),
    });

    const client = new NotebookLmClient(
      {
        projectNumber: '123456789012',
        location: 'global',
        endpointLocation: 'global',
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getAccessToken: () => 'test-token',
      },
    );

    const tmpFile = path.join(os.tmpdir(), `nanoclaw-nblm-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, '# test\n');

    try {
      await client.uploadFileSource(
        'nb-1',
        tmpFile,
        'notes.md',
        'text/markdown',
      );
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://global-discoveryengine.googleapis.com/upload/v1alpha/projects/123456789012/locations/global/notebooks/nb-1/sources:uploadFile',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
            'X-Goog-Upload-File-Name': 'notes.md',
            'X-Goog-Upload-Protocol': 'raw',
            'Content-Type': 'text/markdown',
          }),
        }),
      );
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe('NotebookLM file handling', () => {
  it('infers common content types', () => {
    expect(inferNotebookLmContentType('notes.md')).toBe('text/markdown');
    expect(inferNotebookLmContentType('slides.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
  });

  it('rejects unsupported file extensions', () => {
    expect(() => inferNotebookLmContentType('archive.zip')).toThrow(
      /Unsupported file type/,
    );
  });

  it('allows files inside the current group folder and blocks unrelated paths', () => {
    const groupFolder = `notebooklm-test-${Date.now()}`;
    const groupDir = path.join(process.cwd(), 'groups', groupFolder);
    fs.mkdirSync(groupDir, { recursive: true });

    const allowedFile = path.join(groupDir, 'allowed.md');
    const blockedFile = path.join(
      os.tmpdir(),
      `nanoclaw-blocked-${Date.now()}.md`,
    );
    fs.writeFileSync(allowedFile, 'ok');
    fs.writeFileSync(blockedFile, 'blocked');

    try {
      expect(resolveNotebookLmFilePath('allowed.md', groupFolder, false)).toBe(
        fs.realpathSync(allowedFile),
      );
      expect(() =>
        resolveNotebookLmFilePath(blockedFile, groupFolder, false),
      ).toThrow(/outside NotebookLM allowed roots/);
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
      fs.rmSync(blockedFile, { force: true });
    }
  });

  it('adds batch and file sources together', async () => {
    const groupFolder = `notebooklm-test-${Date.now()}`;
    const groupDir = path.join(process.cwd(), 'groups', groupFolder);
    fs.mkdirSync(groupDir, { recursive: true });

    const filePath = path.join(groupDir, 'doc.md');
    fs.writeFileSync(filePath, '# notebook\n');

    const client = {
      batchCreateSources: vi.fn().mockResolvedValue([
        { sourceId: { id: 'src-text' }, title: 'Notes' },
        { sourceId: { id: 'src-web' }, title: 'https://example.com' },
      ]),
      uploadFileSource: vi.fn().mockResolvedValue({
        sourceId: { id: 'src-file' },
      }),
    } as unknown as NotebookLmClient;

    try {
      const result = await addNotebookLmSources(
        'nb-1',
        [
          { type: 'text', text: 'hello', title: 'Notes' },
          { type: 'web', url: 'https://example.com' },
          { type: 'file', path: 'doc.md' },
        ],
        groupFolder,
        false,
        client,
      );

      expect(
        (client as unknown as { batchCreateSources: ReturnType<typeof vi.fn> })
          .batchCreateSources,
      ).toHaveBeenCalledWith('nb-1', [
        { textContent: { sourceName: 'Notes', content: 'hello' } },
        {
          webContent: {
            sourceName: 'https://example.com',
            url: 'https://example.com',
          },
        },
      ]);
      expect(
        (client as unknown as { uploadFileSource: ReturnType<typeof vi.fn> })
          .uploadFileSource,
      ).toHaveBeenCalledWith(
        'nb-1',
        fs.realpathSync(filePath),
        'doc.md',
        'text/markdown',
      );
      expect(result).toEqual({
        createdSources: [
          { sourceId: { id: 'src-text' }, title: 'Notes' },
          { sourceId: { id: 'src-web' }, title: 'https://example.com' },
        ],
        uploadedFiles: [
          {
            sourceId: { id: 'src-file' },
            title: 'doc.md',
            path: fs.realpathSync(filePath),
          },
        ],
      });
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });
});
