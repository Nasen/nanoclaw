import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

export interface ChannelRegistration {
  name: string;
  displayName?: string;
  description?: string;
  requiredEnvVars?: string[];
  factory: ChannelFactory;
}

const registry = new Map<string, ChannelRegistration>();

function normalizeRegistration(
  registrationOrName: ChannelRegistration | string,
  factory?: ChannelFactory,
): ChannelRegistration {
  if (typeof registrationOrName === 'string') {
    if (!factory) {
      throw new Error(
        `registerChannel("${registrationOrName}") requires a factory function.`,
      );
    }
    return { name: registrationOrName, factory };
  }

  return registrationOrName;
}

export function registerChannel(
  registrationOrName: ChannelRegistration | string,
  factory?: ChannelFactory,
): void {
  const registration = normalizeRegistration(registrationOrName, factory);
  if (registry.has(registration.name)) {
    throw new Error(`Channel "${registration.name}" is already registered.`);
  }

  registry.set(registration.name, registration);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name)?.factory;
}

export function getChannelRegistration(
  name: string,
): ChannelRegistration | undefined {
  return registry.get(name);
}

export function getRegisteredChannels(): ChannelRegistration[] {
  return [...registry.values()];
}

export function getRegisteredChannelNames(): string[] {
  return getRegisteredChannels().map((registration) => registration.name);
}

export function resetChannelRegistry(): void {
  registry.clear();
}
