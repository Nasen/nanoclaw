import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { formatOnBehalfAssistantMessage } from './on-behalf-message.js';
import {
  isRingCentralChatJid,
  resolveCurrentChatRcDelivery,
} from './rc-delivery-policy.js';
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
        onBehalfIntent?: boolean;
      };

      if (data.type === 'message' && data.chatJid && data.text) {
        const targetGroup = registeredGroups[data.chatJid];
        if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
          const deliveryDecision = resolveCurrentChatRcDelivery({
            chatJid: data.chatJid,
            requestedMode: data.deliveryMode,
            onBehalfIntent: data.onBehalfIntent === true,
          });
          const outboundText =
            isRingCentralChatJid(data.chatJid) &&
            deliveryDecision.mode === 'personal'
              ? formatOnBehalfAssistantMessage(data.text)
              : data.text;
          await deps.sendMessage(
            data.chatJid,
            outboundText,
            deliveryDecision.mode,
          );
          logger.info(
            {
              chatJid: data.chatJid,
              sourceGroup,
              requestedMode: data.deliveryMode || 'auto',
              deliveryMode: deliveryDecision.mode,
              onBehalfIntent: data.onBehalfIntent === true,
              policyForced: deliveryDecision.policyForced,
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
