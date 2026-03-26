import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { RcDeliveryMode, RegisteredGroup } from './types.js';

interface MessageIpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    rcDeliveryMode?: RcDeliveryMode,
  ) => Promise<void>;
}

export async function processMessageFiles(
  messagesDir: string,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: MessageIpcDeps,
  errorDir: string,
): Promise<void> {
  if (!fs.existsSync(messagesDir)) return;

  const messageFiles = fs
    .readdirSync(messagesDir)
    .filter((file) => file.endsWith('.json'));

  for (const file of messageFiles) {
    const filePath = path.join(messagesDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        type?: string;
        chatJid?: string;
        text?: string;
        deliveryMode?: RcDeliveryMode;
      };

      if (data.type === 'message' && data.chatJid && data.text) {
        const targetGroup = registeredGroups[data.chatJid];
        if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
          const effectiveDeliveryMode =
            sourceGroup === 'rc-personal' ? 'bot' : data.deliveryMode || 'auto';
          await deps.sendMessage(
            data.chatJid,
            data.text,
            effectiveDeliveryMode,
          );
          logger.info(
            {
              chatJid: data.chatJid,
              sourceGroup,
              deliveryMode: effectiveDeliveryMode,
            },
            'IPC message sent',
          );
        } else {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            'Unauthorized IPC message attempt blocked',
          );
        }
      }

      fs.unlinkSync(filePath);
    } catch (err) {
      logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
      fs.mkdirSync(errorDir, { recursive: true });
      fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
    }
  }
}
