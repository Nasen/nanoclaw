import {
  getChannelFactory,
  getRegisteredChannels,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { RingCentralChannel } from './channels/ringcentral.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { Channel, RegisteredGroup } from './types.js';
import { ChannelOpts } from './channels/registry.js';

interface RingCentralBootstrapDeps {
  channelOpts: ChannelOpts;
  channels: Channel[];
  registeredGroups: () => Record<string, RegisteredGroup>;
  setAutoAssist: (enabled: boolean) => void;
  setServiceEnabled: (enabled: boolean, chatJid: string) => Promise<void>;
  onRegisterGroup: (jid: string, group: RegisteredGroup) => void;
}

export async function connectInstalledChannels(
  channels: Channel[],
  channelOpts: ChannelOpts,
): Promise<void> {
  for (const registration of getRegisteredChannels()) {
    const channel = registration.factory(channelOpts);
    if (!channel) {
      logger.warn(
        {
          channel: registration.name,
          requiredEnvVars: registration.requiredEnvVars,
        },
        'Channel installed but not configured — skipping. Check its required env vars or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
}

async function connectRingCentralChannel(
  channels: Channel[],
  channel: RingCentralChannel,
  errorMessage: string,
): Promise<void> {
  channels.push(channel);
  try {
    await channel.connect();
  } catch (err) {
    logger.error({ err }, errorMessage);
    channels.splice(channels.indexOf(channel), 1);
  }
}

async function confirmAutoAssistChange(
  channel: RingCentralChannel,
  registeredGroups: Record<string, RegisteredGroup>,
  enabled: boolean,
): Promise<void> {
  const rcPersonalEntry = Object.entries(registeredGroups).find(
    ([, group]) => group.folder === 'rc-personal',
  );
  if (!rcPersonalEntry) return;

  const [rcPersonalJid] = rcPersonalEntry;
  await channel.sendMessage(
    rcPersonalJid,
    enabled
      ? 'Auto-assistant mode *enabled*. I will respond to DMs on your behalf.'
      : 'Auto-assistant mode *disabled*. DMs will be delivered to you directly.',
  );
}

export async function connectRingCentralChannels({
  channelOpts,
  channels,
  registeredGroups,
  setAutoAssist,
  setServiceEnabled,
  onRegisterGroup,
}: RingCentralBootstrapDeps): Promise<void> {
  const rcEnv = readEnvFile([
    'RC_CLIENT_ID',
    'RC_CLIENT_SECRET',
    'RC_JWT',
    'RC_SERVER',
    'RC_BOT_CLIENT_ID',
    'RC_BOT_CLIENT_SECRET',
    'RC_BOT_TOKEN',
  ]);

  if (rcEnv.RC_CLIENT_ID && rcEnv.RC_CLIENT_SECRET && rcEnv.RC_JWT) {
    const rcChannel = new RingCentralChannel({
      ...channelOpts,
      name: 'rc',
      jidPrefix: 'rc:',
      creds: {
        clientId: rcEnv.RC_CLIENT_ID,
        clientSecret: rcEnv.RC_CLIENT_SECRET,
        jwt: rcEnv.RC_JWT,
        server: rcEnv.RC_SERVER,
      },
      onOwnerCommand: async (command) => {
        if (command.action === 'set_auto_assist') {
          setAutoAssist(command.value);
          await confirmAutoAssistChange(
            rcChannel,
            registeredGroups(),
            command.value,
          );
          return;
        }

        if (command.action === 'set_service_enabled') {
          await setServiceEnabled(command.value, command.chatJid);
        }
      },
    });

    await connectRingCentralChannel(
      channels,
      rcChannel,
      'RingCentral (REST API) channel failed to connect — service continues without it',
    );
  }

  if (
    rcEnv.RC_BOT_CLIENT_ID &&
    rcEnv.RC_BOT_CLIENT_SECRET &&
    rcEnv.RC_BOT_TOKEN
  ) {
    const rcBotChannel = new RingCentralChannel({
      ...channelOpts,
      name: 'rc-bot',
      jidPrefix: 'rcb:',
      autoRegister: true,
      onRegisterGroup,
      creds: {
        clientId: rcEnv.RC_BOT_CLIENT_ID,
        clientSecret: rcEnv.RC_BOT_CLIENT_SECRET,
        botToken: rcEnv.RC_BOT_TOKEN,
        server: rcEnv.RC_SERVER,
      },
    });

    await connectRingCentralChannel(
      channels,
      rcBotChannel,
      'RingCentral (Bot Add-in) channel failed to connect — service continues without it',
    );
  }
}
