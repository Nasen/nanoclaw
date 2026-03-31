import { ContainerOutput } from './container-contract.js';
import { logger } from './logger.js';
import { formatOnBehalfAssistantMessage } from './on-behalf-message.js';
import {
  hasExplicitOnBehalfIntentInMessages,
  isRingCentralChatJid,
  RcDeliveryDecision,
  resolveCurrentChatRcDelivery,
} from './rc-delivery-policy.js';
import { resolveOutboundTarget } from './router.js';
import { Channel } from './types.js';

export function shouldSkipGroupTurnForAutoAssist(params: {
  personalRcDm: boolean;
  autoAssistEnabled: boolean;
  hasSlashCommand: boolean;
}): boolean {
  return (
    params.personalRcDm && !params.autoAssistEnabled && !params.hasSlashCommand
  );
}

export function buildGroupTurnPrompt(params: {
  chatJid: string;
  groupFolder: string;
  messages: Array<{ content: string; is_from_me?: boolean }>;
  turnText: string;
  turnMode: 'formatted' | 'raw';
  personalRcDm: boolean;
  autoAssistEnabled: boolean;
}): { prompt: string; deliveryDecision: RcDeliveryDecision } {
  const onBehalfIntent = hasExplicitOnBehalfIntentInMessages(params.messages);
  const deliveryDecision = resolveCurrentChatRcDelivery({
    chatJid: params.chatJid,
    onBehalfIntent,
  });

  if (params.turnMode === 'raw') {
    return {
      prompt: params.turnText,
      deliveryDecision,
    };
  }

  const autoAssistPrefix =
    params.personalRcDm && params.autoAssistEnabled
      ? '[Auto-assistant mode is ON. Nasen is away. Respond on his behalf — including any backlog messages sent while auto-assist was off.]\n\n'
      : '';

  const rcRoutingPrefix =
    params.chatJid.startsWith('rc:') || params.chatJid.startsWith('rcb:')
      ? params.groupFolder === 'rc-personal'
        ? '[RingCentral routing: For this chat, normal replies use bot delivery by policy. Only explicit on-behalf requests should use personal delivery.]\n\n'
        : deliveryDecision.mode === 'personal'
          ? "[RingCentral routing: The latest user request explicitly asks you to act on Nasen's behalf. Outbound actions for this current chat must use personal delivery.]\n\n"
          : '[RingCentral routing: Normal replies in RingCentral use bot delivery by policy. Personal delivery is only for explicit on-behalf requests.]\n\n'
      : '';

  return {
    prompt: autoAssistPrefix + rcRoutingPrefix + params.turnText,
    deliveryDecision,
  };
}

export async function relayGroupTurnResult(params: {
  result: ContainerOutput;
  groupName: string;
  channels: Channel[];
  chatJid: string;
  deliveryDecision: RcDeliveryDecision;
}): Promise<boolean> {
  if (!params.result.result) return false;

  const raw =
    typeof params.result.result === 'string'
      ? params.result.result
      : JSON.stringify(params.result.result);
  const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();

  logger.info(
    { group: params.groupName },
    `Agent output: ${raw.slice(0, 200)}`,
  );
  if (!text) return false;

  if (params.deliveryDecision.policyForced && params.chatJid.startsWith('rc')) {
    logger.info(
      {
        group: params.groupName,
        requestedMode: 'auto',
        enforcedMode: params.deliveryDecision.mode,
      },
      'Applied host-enforced RingCentral current-chat delivery policy',
    );
  }

  const target = resolveOutboundTarget(
    params.channels,
    params.chatJid,
    params.deliveryDecision.mode,
  );
  if (!target) {
    throw new Error(`No channel for JID: ${params.chatJid}`);
  }

  const outboundText =
    isRingCentralChatJid(params.chatJid) &&
    params.deliveryDecision.mode === 'personal'
      ? formatOnBehalfAssistantMessage(text)
      : text;
  await target.channel.sendMessage(target.jid, outboundText);
  return true;
}
