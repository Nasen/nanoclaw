import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { processMessageFiles } from './ipc-message-handler.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

describe('processMessageFiles', () => {
  const root = path.join(process.cwd(), 'data', 'test-ipc-message-handler');
  const messagesDir = path.join(root, 'messages');
  const errorDir = path.join(root, 'errors');

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.mkdirSync(errorDir, { recursive: true });
  });

  it('defaults rc-personal IPC sends to bot delivery', async () => {
    fs.writeFileSync(
      path.join(messagesDir, 'msg-1.json'),
      JSON.stringify({
        type: 'message',
        chatJid: 'rcb:157530931206',
        text: 'hello',
      }),
    );

    const sendMessage = vi.fn(async () => {});

    await processMessageFiles(
      messagesDir,
      'rc-personal',
      false,
      {
        'rcb:157530931206': {
          ...MAIN_GROUP,
          folder: 'rc-personal',
        },
      },
      { sendMessage },
      errorDir,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'rcb:157530931206',
      'hello',
      'bot',
    );
  });

  it('honors explicit personal delivery for rc-personal IPC sends', async () => {
    fs.writeFileSync(
      path.join(messagesDir, 'msg-2.json'),
      JSON.stringify({
        type: 'message',
        chatJid: 'rc:12345',
        text: 'hello',
        deliveryMode: 'personal',
        onBehalfIntent: true,
      }),
    );

    const sendMessage = vi.fn(async () => {});

    await processMessageFiles(
      messagesDir,
      'rc-personal',
      false,
      {
        'rc:12345': {
          ...MAIN_GROUP,
          folder: 'rc-personal',
        },
      },
      { sendMessage },
      errorDir,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'rc:12345',
      "[On Nasen's behalf] hello",
      'personal',
    );
  });

  it('honors explicit personal delivery without host downgrade', async () => {
    fs.writeFileSync(
      path.join(messagesDir, 'msg-3.json'),
      JSON.stringify({
        type: 'message',
        chatJid: 'rc:12345',
        text: 'hello',
        deliveryMode: 'personal',
      }),
    );

    const sendMessage = vi.fn(async () => {});

    await processMessageFiles(
      messagesDir,
      'rc-personal',
      false,
      {
        'rc:12345': {
          ...MAIN_GROUP,
          folder: 'rc-personal',
        },
      },
      { sendMessage },
      errorDir,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'rc:12345',
      "[On Nasen's behalf] hello",
      'personal',
    );
  });

  it('downgrades specialist admin personal delivery to bot delivery', async () => {
    fs.writeFileSync(
      path.join(messagesDir, 'msg-4.json'),
      JSON.stringify({
        type: 'message',
        chatJid: 'rc:777',
        text: 'hello',
        deliveryMode: 'personal',
        onBehalfIntent: true,
      }),
    );

    const sendMessage = vi.fn(async () => {});

    await processMessageFiles(
      messagesDir,
      'rc-grp-nanoclaw-gitops',
      true,
      {
        'rc:777': {
          ...MAIN_GROUP,
          folder: 'rc-grp-nanoclaw-gitops',
        },
      },
      { sendMessage },
      errorDir,
    );

    expect(sendMessage).toHaveBeenCalledWith('rc:777', 'hello', 'bot');
  });
});
