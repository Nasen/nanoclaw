import { Channel, NewMessage, RcDeliveryMode } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const target = resolveOutboundTarget(channels, jid);
  if (!target) throw new Error(`No channel for JID: ${jid}`);
  return target.channel.sendMessage(target.jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

function isRingCentralJid(jid: string): boolean {
  return jid.startsWith('rc:') || jid.startsWith('rcb:');
}

function swapRingCentralPrefix(
  jid: string,
  targetPrefix: 'rc:' | 'rcb:',
): string {
  if (jid.startsWith('rc:')) return `${targetPrefix}${jid.slice(3)}`;
  if (jid.startsWith('rcb:')) return `${targetPrefix}${jid.slice(4)}`;
  return jid;
}

export function resolveOutboundTarget(
  channels: Channel[],
  jid: string,
  rcDeliveryMode: RcDeliveryMode = 'auto',
): { channel: Channel; jid: string } | null {
  if (isRingCentralJid(jid)) {
    const preferredPrefix =
      rcDeliveryMode === 'personal'
        ? 'rc:'
        : rcDeliveryMode === 'bot'
          ? 'rcb:'
          : null;

    if (preferredPrefix) {
      const preferredJid = swapRingCentralPrefix(jid, preferredPrefix);
      const preferredChannel = findChannel(channels, preferredJid);
      if (preferredChannel) {
        return { channel: preferredChannel, jid: preferredJid };
      }
    }
  }

  const channel = findChannel(channels, jid);
  if (!channel) return null;
  return { channel, jid };
}
