import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import type { ExternalMcpCapability } from './container-contract.js';
import { RegisteredGroup } from './types.js';

export type NanoclawToolName =
  | 'send_message'
  | 'schedule_task'
  | 'list_tasks'
  | 'pause_task'
  | 'resume_task'
  | 'cancel_task'
  | 'update_task'
  | 'register_group'
  | 'delegate_to_group'
  | 'list_rc_chats'
  | 'read_rc_messages'
  | 'send_rc_message'
  | 'send_rc_dm'
  | 'list_rc_chat_members'
  | 'get_rc_presence'
  | 'set_rc_presence'
  | 'get_rc_extension'
  | 'list_rc_extensions'
  | 'list_rc_contacts'
  | 'create_rc_contact'
  | 'list_rc_phone_numbers'
  | 'list_notebooklm_notebooks'
  | 'create_notebooklm_notebook'
  | 'get_notebooklm_notebook'
  | 'add_notebooklm_sources';

type AdminAgentRole =
  | 'supervisor'
  | 'ciops'
  | 'peopleops'
  | 'jiraops'
  | 'gitops'
  | 'testautomation'
  | 'testdesign'
  | 'featuredevelopment'
  | 'codereview'
  | 'rcvops';

type ToolProfileId =
  | 'supervisor'
  | 'ciops'
  | 'peopleops'
  | 'jiraops'
  | 'gitops'
  | 'testautomation'
  | 'testdesign'
  | 'featuredevelopment'
  | 'codereview'
  | 'rcvops';

type MountProfileId =
  | 'supervisor'
  | 'projects-readwrite'
  | 'projects-readonly'
  | 'none';

interface AdminAgentProfileConfig {
  role: AdminAgentRole;
  purpose: string;
  toolProfile: ToolProfileId;
  mountProfile: MountProfileId;
  allowedPeers: string[];
  canSpeakAsOwner: boolean;
}

interface AdminAgentsConfig {
  supervisorFolder: string;
  profiles: Record<string, AdminAgentProfileConfig>;
}

interface ToolProfile {
  nanoclawTools: NanoclawToolName[];
  externalMcpCapabilities: ExternalMcpCapability[];
  envKeys: string[];
  mountGmailTokens: boolean;
  mountOutlookTokens: boolean;
  mountFigmaMcp: boolean;
  allowGitAuth: boolean;
}

export interface ResolvedAdminAgentProfile extends AdminAgentProfileConfig {
  folder: string;
  supervisorFolder: string;
  nanoclawTools: NanoclawToolName[];
  externalMcpCapabilities: ExternalMcpCapability[];
  envKeys: string[];
  mountGmailTokens: boolean;
  mountOutlookTokens: boolean;
  mountFigmaMcp: boolean;
  allowGitAuth: boolean;
}

const ADMIN_AGENTS_CONFIG_PATH = path.join(GROUPS_DIR, 'admin-agents.json');

const TASK_TOOLS: NanoclawToolName[] = [
  'schedule_task',
  'list_tasks',
  'pause_task',
  'resume_task',
  'cancel_task',
  'update_task',
];

const SUPERVISOR_ONLY_TOOLS: NanoclawToolName[] = [
  'register_group',
  'send_rc_message',
  'send_rc_dm',
  'get_rc_presence',
  'set_rc_presence',
  'create_rc_contact',
  'list_rc_phone_numbers',
  'list_notebooklm_notebooks',
  'create_notebooklm_notebook',
  'get_notebooklm_notebook',
  'add_notebooklm_sources',
];

const PEOPLEOPS_RC_READ_TOOLS: NanoclawToolName[] = [
  'list_rc_chats',
  'read_rc_messages',
  'list_rc_chat_members',
  'get_rc_extension',
  'list_rc_extensions',
  'list_rc_contacts',
];

const BASE_SPECIALIST_TOOLS: NanoclawToolName[] = [
  'send_message',
  'delegate_to_group',
  ...TASK_TOOLS,
];

const TOOL_PROFILES: Record<ToolProfileId, ToolProfile> = {
  supervisor: {
    nanoclawTools: [
      'send_message',
      'delegate_to_group',
      ...TASK_TOOLS,
      ...SUPERVISOR_ONLY_TOOLS,
      ...PEOPLEOPS_RC_READ_TOOLS,
    ],
    externalMcpCapabilities: [
      'gmail',
      'jira',
      'testit',
      'figma',
      'gitlab',
      'm365',
    ],
    envKeys: [
      'JIRA_TOKEN',
      'CONFLUENCE_READ_TOKEN',
      'TESTIT_ACCESS_TOKEN',
      'GITLAB_PERSONAL_ACCESS_TOKEN',
      'RC_CLIENT_ID',
      'RC_CLIENT_SECRET',
      'RC_JWT',
      'RC_SERVER',
      'OUTLOOK_CLIENT_ID',
      'OUTLOOK_CLIENT_SECRET',
      'MS_TENANT_ID',
      'JENKINS_URL',
      'JENKINS_USER',
      'JENKINS_TOKEN',
    ],
    mountGmailTokens: true,
    mountOutlookTokens: true,
    mountFigmaMcp: true,
    allowGitAuth: true,
  },
  ciops: {
    nanoclawTools: [...BASE_SPECIALIST_TOOLS],
    externalMcpCapabilities: ['gitlab'],
    envKeys: [
      'GITLAB_PERSONAL_ACCESS_TOKEN',
      'JENKINS_URL',
      'JENKINS_USER',
      'JENKINS_TOKEN',
    ],
    mountGmailTokens: false,
    mountOutlookTokens: false,
    mountFigmaMcp: false,
    allowGitAuth: true,
  },
  peopleops: {
    nanoclawTools: [...BASE_SPECIALIST_TOOLS, ...PEOPLEOPS_RC_READ_TOOLS],
    externalMcpCapabilities: ['gmail', 'm365'],
    envKeys: [
      'OUTLOOK_CLIENT_ID',
      'OUTLOOK_CLIENT_SECRET',
      'MS_TENANT_ID',
    ],
    mountGmailTokens: true,
    mountOutlookTokens: true,
    mountFigmaMcp: false,
    allowGitAuth: false,
  },
  jiraops: {
    nanoclawTools: [...BASE_SPECIALIST_TOOLS],
    externalMcpCapabilities: ['jira'],
    envKeys: ['JIRA_TOKEN', 'CONFLUENCE_READ_TOKEN'],
    mountGmailTokens: false,
    mountOutlookTokens: false,
    mountFigmaMcp: false,
    allowGitAuth: false,
  },
  gitops: {
    nanoclawTools: [...BASE_SPECIALIST_TOOLS],
    externalMcpCapabilities: ['gitlab'],
    envKeys: ['GITLAB_PERSONAL_ACCESS_TOKEN'],
    mountGmailTokens: false,
    mountOutlookTokens: false,
    mountFigmaMcp: false,
    allowGitAuth: true,
  },
  testautomation: {
    nanoclawTools: [...BASE_SPECIALIST_TOOLS],
    externalMcpCapabilities: ['jira', 'testit', 'gitlab'],
    envKeys: [
      'JIRA_TOKEN',
      'CONFLUENCE_READ_TOKEN',
      'TESTIT_ACCESS_TOKEN',
      'GITLAB_PERSONAL_ACCESS_TOKEN',
    ],
    mountGmailTokens: false,
    mountOutlookTokens: false,
    mountFigmaMcp: false,
    allowGitAuth: true,
  },
  testdesign: {
    nanoclawTools: [...BASE_SPECIALIST_TOOLS],
    externalMcpCapabilities: ['jira', 'testit'],
    envKeys: ['JIRA_TOKEN', 'CONFLUENCE_READ_TOKEN', 'TESTIT_ACCESS_TOKEN'],
    mountGmailTokens: false,
    mountOutlookTokens: false,
    mountFigmaMcp: false,
    allowGitAuth: false,
  },
  featuredevelopment: {
    nanoclawTools: [...BASE_SPECIALIST_TOOLS],
    externalMcpCapabilities: ['jira', 'gitlab', 'figma'],
    envKeys: [
      'JIRA_TOKEN',
      'CONFLUENCE_READ_TOKEN',
      'GITLAB_PERSONAL_ACCESS_TOKEN',
    ],
    mountGmailTokens: false,
    mountOutlookTokens: false,
    mountFigmaMcp: true,
    allowGitAuth: true,
  },
  codereview: {
    nanoclawTools: [...BASE_SPECIALIST_TOOLS],
    externalMcpCapabilities: ['jira', 'gitlab'],
    envKeys: [
      'JIRA_TOKEN',
      'CONFLUENCE_READ_TOKEN',
      'GITLAB_PERSONAL_ACCESS_TOKEN',
    ],
    mountGmailTokens: false,
    mountOutlookTokens: false,
    mountFigmaMcp: false,
    allowGitAuth: false,
  },
  rcvops: {
    nanoclawTools: [...BASE_SPECIALIST_TOOLS],
    externalMcpCapabilities: ['jira', 'gitlab'],
    envKeys: [
      'JIRA_TOKEN',
      'CONFLUENCE_READ_TOKEN',
      'GITLAB_PERSONAL_ACCESS_TOKEN',
      'JENKINS_URL',
      'JENKINS_USER',
      'JENKINS_TOKEN',
    ],
    mountGmailTokens: false,
    mountOutlookTokens: false,
    mountFigmaMcp: false,
    allowGitAuth: true,
  },
};

function loadAdminAgentsConfig(): AdminAgentsConfig | null {
  try {
    const raw = fs.readFileSync(ADMIN_AGENTS_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as AdminAgentsConfig;
  } catch {
    return null;
  }
}

export function getAdminAgentProfile(
  folder: string,
): ResolvedAdminAgentProfile | null {
  const config = loadAdminAgentsConfig();
  if (!config) return null;

  const profile = config.profiles[folder];
  if (!profile) return null;

  const toolProfile = TOOL_PROFILES[profile.toolProfile];
  return {
    ...profile,
    folder,
    supervisorFolder: config.supervisorFolder,
    nanoclawTools: [...toolProfile.nanoclawTools],
    externalMcpCapabilities: [...toolProfile.externalMcpCapabilities],
    envKeys: [...toolProfile.envKeys],
    mountGmailTokens: toolProfile.mountGmailTokens,
    mountOutlookTokens: toolProfile.mountOutlookTokens,
    mountFigmaMcp: toolProfile.mountFigmaMcp,
    allowGitAuth: toolProfile.allowGitAuth,
  };
}

export function isSupervisorGroup(folder: string): boolean {
  const profile = getAdminAgentProfile(folder);
  return profile?.role === 'supervisor';
}

export function isSpecialistAdminGroup(folder: string): boolean {
  const profile = getAdminAgentProfile(folder);
  return !!profile && profile.role !== 'supervisor';
}

export function canAdminAgentDelegate(
  sourceFolder: string,
  targetFolder: string,
): boolean {
  const sourceProfile = getAdminAgentProfile(sourceFolder);
  const targetProfile = getAdminAgentProfile(targetFolder);
  if (!sourceProfile || !targetProfile) return false;
  if (sourceFolder === targetFolder) return false;

  if (sourceProfile.role === 'supervisor') {
    return true;
  }

  return sourceProfile.allowedPeers.includes(targetFolder);
}

export function canAdminAgentSpeakAsOwner(folder: string): boolean {
  return getAdminAgentProfile(folder)?.canSpeakAsOwner === true;
}

export function hasAdminAgentToolAccess(
  folder: string,
  tool: NanoclawToolName,
): boolean {
  const profile = getAdminAgentProfile(folder);
  if (!profile) return false;
  return profile.nanoclawTools.includes(tool);
}

export function getAdminAgentProjectMountMode(
  folder: string,
): MountProfileId | null {
  return getAdminAgentProfile(folder)?.mountProfile ?? null;
}

export function getAdminAgentPromptHeader(group: RegisteredGroup): string {
  const profile = getAdminAgentProfile(group.folder);
  if (!profile) return '';

  const lines = [
    `[Admin agent role: ${profile.role}]`,
    `[Purpose: ${profile.purpose}]`,
    `[Allowed peer agents: ${profile.allowedPeers.join(', ') || 'none'}]`,
  ];

  if (profile.role === 'supervisor') {
    lines.push(
      '[You are the supervisor channel. You may coordinate specialist agents, approve guarded actions, and decide when to delegate.]',
    );
    lines.push(
      '[You are the only admin channel allowed to use owner voice or act as Nasen by default.]',
    );
    lines.push(
      '[Use delegate_to_group for bounded specialist subtasks when another admin role is a better fit.]',
    );
  } else {
    lines.push(
      '[You are a specialist operator agent for this team chat. Stay inside your domain and respond as the specialist, not as Nasen.]',
    );
    lines.push(
      '[Do not act as Nasen, do not use owner voice, and do not use personal RingCentral delivery. Escalate those requests to rc-personal.]',
    );
    lines.push(
      '[Use delegate_to_group only when another specialist can materially advance the task faster or with better domain context.]',
    );
    lines.push(
      '[Escalate guarded actions such as owner-voice communication, git push approval, or other high-risk actions to rc-personal.]',
    );
  }

  return `${lines.join('\n')}\n\n`;
}
