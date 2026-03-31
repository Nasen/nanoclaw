import { AvailableGroup } from './container-contract.js';
import {
  NotebookLmAddSourcesResult,
  NotebookLmNotebook,
  NotebookLmSourceInput,
} from './notebooklm.js';
import {
  RcChatMember,
  RcChatSummary,
  RcChatTranscript,
  RcContact,
  RcContactInput,
  RcExtensionSummary,
  RcPhoneNumber,
  RcPresence,
  RcPresenceUpdateInput,
} from './channels/ringcentral.js';
import { RcDeliveryMode, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    rcDeliveryMode?: RcDeliveryMode,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  rcListChats: (
    mode: RcDeliveryMode,
    query?: string,
    limit?: number,
  ) => Promise<RcChatSummary[]>;
  rcReadMessages: (
    chatRef: string,
    mode: RcDeliveryMode,
    limit?: number,
  ) => Promise<RcChatTranscript>;
  rcSendMessage: (
    chatRef: string,
    text: string,
    mode: RcDeliveryMode,
  ) => Promise<{ jid: string; chatId: string; postId?: string }>;
  rcListChatMembers: (
    chatRef: string,
    mode: RcDeliveryMode,
    limit?: number,
  ) => Promise<RcChatMember[]>;
  rcGetPresence: (
    mode: RcDeliveryMode,
    extensionId?: string,
  ) => Promise<RcPresence>;
  rcSetPresence: (
    mode: RcDeliveryMode,
    update: RcPresenceUpdateInput,
  ) => Promise<RcPresence>;
  rcGetExtension: (
    mode: RcDeliveryMode,
    extensionId?: string,
  ) => Promise<RcExtensionSummary>;
  rcListExtensions: (
    mode: RcDeliveryMode,
    query?: string,
    limit?: number,
  ) => Promise<RcExtensionSummary[]>;
  rcListContacts: (
    mode: RcDeliveryMode,
    query?: string,
    limit?: number,
  ) => Promise<RcContact[]>;
  rcCreateContact: (
    mode: RcDeliveryMode,
    contact: RcContactInput,
  ) => Promise<RcContact>;
  rcListPhoneNumbers: (
    mode: RcDeliveryMode,
    limit?: number,
  ) => Promise<RcPhoneNumber[]>;
  notebookLmListNotebooks: (limit?: number) => Promise<NotebookLmNotebook[]>;
  notebookLmCreateNotebook: (title: string) => Promise<NotebookLmNotebook>;
  notebookLmGetNotebook: (notebookId: string) => Promise<NotebookLmNotebook>;
  notebookLmAddSources: (
    notebookId: string,
    sources: NotebookLmSourceInput[],
    sourceGroup: string,
    isMain: boolean,
  ) => Promise<NotebookLmAddSourcesResult>;
}
