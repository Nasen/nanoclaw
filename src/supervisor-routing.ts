import {
  getAdminAgentProfile,
  isSupervisorGroup,
  type ResolvedAdminAgentProfile,
} from './admin-agents.js';
import { RegisteredGroup } from './types.js';

type SpecialistRole = Exclude<ResolvedAdminAgentProfile['role'], 'supervisor'>;

export type SupervisorRouteMode = 'self' | 'delegate' | 'collaborate';
export type SupervisorRouteConfidence = 'low' | 'medium' | 'high';

export interface SupervisorRouteScore {
  role: SpecialistRole;
  targetGroupFolder: string;
  score: number;
  reasons: string[];
}

export interface SupervisorRouteDecision {
  mode: SupervisorRouteMode;
  confidence: SupervisorRouteConfidence;
  targetGroupFolder?: string;
  collaboratorGroupFolders?: string[];
  reason: string;
  scoreBreakdown: SupervisorRouteScore[];
}

interface RoutingSignals {
  promptLower: string;
  exactCaseIds: string[];
  hasRepoReference: boolean;
  hasImplementationVerb: boolean;
  hasSearchIntent: boolean;
}

interface RoleRoutingRule {
  role: SpecialistRole;
  domainTerms: string[];
  strongPhrases: string[];
  actionTerms: string[];
  artifactPatterns?: RegExp[];
  score: (signals: RoutingSignals) => { score: number; reasons: string[] };
}

const EXACT_CASE_ID_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const REPO_REFERENCE_PATTERN =
  /\b(repo|repository|codebase|project|src\/|cases\/|package\.json|playwright|e2e)\b/i;
const IMPLEMENTATION_VERB_PATTERN =
  /\b(implement|automation|automate|write|add|create|fix|update|modify|code|build|patch|refactor)\b/i;
const SEARCH_INTENT_PATTERN =
  /\b(search|find|list|query|matching|all matching|similar)\b/i;
const SELF_OVERRIDE_PATTERN =
  /\b(handle (?:it|this|the task)? directly|do it yourself|no delegation|don't delegate|without delegating|keep this in personal)\b/i;

const ROLE_LABELS: Record<SpecialistRole, string[]> = {
  ciops: ['ciops', 'ci ops', 'pipeline', 'build', 'jenkins', 'release'],
  peopleops: ['peopleops', 'people ops', 'people', 'communication', 'email'],
  jiraops: ['jiraops', 'jira ops', 'jira', 'ticket', 'backlog', 'sprint'],
  gitops: ['gitops', 'git ops', 'git', 'branch', 'merge', 'commit'],
  testautomation: [
    'test automation',
    'testautomation',
    'automation',
    'e2e',
    'playwright',
  ],
  testdesign: ['test design', 'testdesign', 'coverage', 'scenario', 'risk'],
  featuredevelopment: [
    'feature development',
    'featuredevelopment',
    'implementation',
    'debugging',
  ],
  codereview: ['code review', 'codereview', 'review', 'regression'],
  rcvops: ['rcv ops', 'rcvops', 'sre', 'incident', 'outage'],
};

const ROLE_RULES: RoleRoutingRule[] = [
  {
    role: 'testautomation',
    domainTerms: [
      'testit',
      'test case',
      'automation',
      'playwright',
      'e2e',
      'flaky test',
      'existing skills',
    ],
    strongPhrases: [
      'test case automation',
      'implement test case automation',
      'automate test case',
      'automation for testit case',
    ],
    actionTerms: ['implement', 'automate', 'write', 'add', 'fix', 'update'],
    artifactPatterns: [/\bNRCV-\d+\b/i, /\be2e\b/i],
    score: (signals) => {
      const score = collectRoleScore(signals, {
        domainTerms: [
          'testit',
          'test case',
          'automation',
          'playwright',
          'e2e',
          'existing skills',
        ],
        strongPhrases: [
          'test case automation',
          'implement test case automation',
          'automate test case',
          'automation for testit case',
        ],
        actionTerms: ['implement', 'automate', 'write', 'add', 'fix', 'update'],
        artifactPatterns: [/\b[A-Z][A-Z0-9]+-\d+\b/, /\be2e\b/],
      });

      if (
        signals.exactCaseIds.length > 0 &&
        signals.hasImplementationVerb &&
        (signals.promptLower.includes('testit') ||
          signals.promptLower.includes('test case'))
      ) {
        score.score += 5;
        score.reasons.push('exact TestIT case ID plus implementation intent');
      }

      if (signals.hasRepoReference) {
        score.score += 2;
        score.reasons.push('repo/codebase target present');
      }

      return score;
    },
  },
  {
    role: 'testdesign',
    domainTerms: [
      'test plan',
      'test design',
      'coverage',
      'scenario',
      'risk',
      'quality',
    ],
    strongPhrases: ['design test cases', 'test strategy', 'coverage analysis'],
    actionTerms: ['design', 'analyze', 'review', 'plan'],
    score: (signals) =>
      collectRoleScore(signals, {
        domainTerms: [
          'test plan',
          'test design',
          'coverage',
          'scenario',
          'risk',
          'quality',
        ],
        strongPhrases: ['design test cases', 'test strategy', 'coverage analysis'],
        actionTerms: ['design', 'analyze', 'review', 'plan'],
      }),
  },
  {
    role: 'featuredevelopment',
    domainTerms: ['feature', 'bug', 'implementation', 'debug', 'code', 'repo'],
    strongPhrases: ['implement feature', 'fix bug', 'debug this issue'],
    actionTerms: ['implement', 'build', 'fix', 'debug', 'refactor', 'write'],
    score: (signals) => {
      const score = collectRoleScore(signals, {
        domainTerms: ['feature', 'bug', 'implementation', 'debug', 'code', 'repo'],
        strongPhrases: ['implement feature', 'fix bug', 'debug this issue'],
        actionTerms: ['implement', 'build', 'fix', 'debug', 'refactor', 'write'],
      });

      if (signals.hasRepoReference && signals.hasImplementationVerb) {
        score.score += 2;
        score.reasons.push('repo target plus implementation intent');
      }

      return score;
    },
  },
  {
    role: 'gitops',
    domainTerms: ['git', 'branch', 'merge', 'mr', 'commit', 'rebase', 'push'],
    strongPhrases: ['open merge request', 'create branch', 'git operation'],
    actionTerms: ['commit', 'push', 'rebase', 'merge', 'cherry-pick', 'checkout'],
    score: (signals) =>
      collectRoleScore(signals, {
        domainTerms: [
          'git',
          'branch',
          'merge',
          'mr',
          'commit',
          'rebase',
          'push',
        ],
        strongPhrases: ['open merge request', 'create branch', 'git operation'],
        actionTerms: ['commit', 'push', 'rebase', 'merge', 'cherry-pick', 'checkout'],
      }),
  },
  {
    role: 'jiraops',
    domainTerms: ['jira', 'ticket', 'issue', 'backlog', 'sprint', 'story', 'epic'],
    strongPhrases: ['update jira', 'create jira', 'triage backlog'],
    actionTerms: ['update', 'create', 'triage', 'move', 'assign', 'summarize'],
    score: (signals) =>
      collectRoleScore(signals, {
        domainTerms: [
          'jira',
          'ticket',
          'issue',
          'backlog',
          'sprint',
          'story',
          'epic',
        ],
        strongPhrases: ['update jira', 'create jira', 'triage backlog'],
        actionTerms: ['update', 'create', 'triage', 'move', 'assign', 'summarize'],
      }),
  },
  {
    role: 'ciops',
    domainTerms: ['ci', 'pipeline', 'build', 'jenkins', 'release', 'workflow'],
    strongPhrases: ['pipeline failure', 'build health', 'release automation'],
    actionTerms: ['fix', 'rerun', 'stabilize', 'release', 'diagnose'],
    score: (signals) =>
      collectRoleScore(signals, {
        domainTerms: ['ci', 'pipeline', 'build', 'jenkins', 'release', 'workflow'],
        strongPhrases: ['pipeline failure', 'build health', 'release automation'],
        actionTerms: ['fix', 'rerun', 'stabilize', 'release', 'diagnose'],
      }),
  },
  {
    role: 'peopleops',
    domainTerms: ['people', 'email', 'message', 'follow-up', 'communication', 'contact'],
    strongPhrases: ['draft a reply', 'draft a message', 'send a follow-up'],
    actionTerms: ['draft', 'reply', 'follow up', 'summarize', 'communicate'],
    score: (signals) =>
      collectRoleScore(signals, {
        domainTerms: [
          'people',
          'email',
          'message',
          'follow-up',
          'communication',
          'contact',
        ],
        strongPhrases: ['draft a reply', 'draft a message', 'send a follow-up'],
        actionTerms: ['draft', 'reply', 'follow up', 'summarize', 'communicate'],
      }),
  },
  {
    role: 'codereview',
    domainTerms: ['review', 'code review', 'regression', 'risk', 'pr', 'mr'],
    strongPhrases: ['review this patch', 'perform code review', 'regression analysis'],
    actionTerms: ['review', 'analyze', 'inspect', 'check'],
    score: (signals) =>
      collectRoleScore(signals, {
        domainTerms: ['review', 'code review', 'regression', 'risk', 'pr', 'mr'],
        strongPhrases: [
          'review this patch',
          'perform code review',
          'regression analysis',
        ],
        actionTerms: ['review', 'analyze', 'inspect', 'check'],
      }),
  },
  {
    role: 'rcvops',
    domainTerms: ['incident', 'outage', 'sre', 'service', 'logs', 'diagnose', 'root cause'],
    strongPhrases: ['root cause analysis', 'incident diagnosis', 'service outage'],
    actionTerms: ['diagnose', 'investigate', 'mitigate', 'stabilize', 'fix'],
    score: (signals) =>
      collectRoleScore(signals, {
        domainTerms: [
          'incident',
          'outage',
          'sre',
          'service',
          'logs',
          'diagnose',
          'root cause',
        ],
        strongPhrases: ['root cause analysis', 'incident diagnosis', 'service outage'],
        actionTerms: ['diagnose', 'investigate', 'mitigate', 'stabilize', 'fix'],
      }),
  },
];

function collectRoleScore(
  signals: RoutingSignals,
  params: {
    domainTerms: string[];
    strongPhrases: string[];
    actionTerms: string[];
    artifactPatterns?: RegExp[];
  },
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  for (const phrase of params.strongPhrases) {
    if (!signals.promptLower.includes(phrase)) continue;
    score += 4;
    reasons.push(`matched phrase "${phrase}"`);
  }

  for (const term of params.domainTerms) {
    if (!signals.promptLower.includes(term)) continue;
    score += 2;
    reasons.push(`matched term "${term}"`);
  }

  const hasActionMatch = params.actionTerms.some((term) =>
    signals.promptLower.includes(term),
  );
  const hasDomainMatch = params.domainTerms.some((term) =>
    signals.promptLower.includes(term),
  );
  if (hasActionMatch && hasDomainMatch) {
    score += 3;
    reasons.push('matched action plus domain');
  }

  for (const pattern of params.artifactPatterns ?? []) {
    if (!pattern.test(signals.promptLower)) continue;
    score += 2;
    reasons.push(`matched artifact ${pattern.source}`);
  }

  return { score, reasons };
}

function collectSignals(prompt: string): RoutingSignals {
  return {
    promptLower: prompt.toLowerCase(),
    exactCaseIds: [...new Set(prompt.match(EXACT_CASE_ID_PATTERN) ?? [])],
    hasRepoReference: REPO_REFERENCE_PATTERN.test(prompt),
    hasImplementationVerb: IMPLEMENTATION_VERB_PATTERN.test(prompt),
    hasSearchIntent: SEARCH_INTENT_PATTERN.test(prompt),
  };
}

function resolveTargetFolderForRole(
  role: SpecialistRole,
  registeredGroups: Record<string, RegisteredGroup>,
): string | null {
  const entry = Object.values(registeredGroups).find(
    (group) => getAdminAgentProfile(group.folder)?.role === role,
  );
  return entry?.folder ?? null;
}

function hasExplicitSelfOverride(prompt: string): boolean {
  return SELF_OVERRIDE_PATTERN.test(prompt);
}

function resolveExplicitDelegateTarget(
  prompt: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | null {
  const promptLower = prompt.toLowerCase();

  for (const group of Object.values(registeredGroups)) {
    const profile = getAdminAgentProfile(group.folder);
    if (!profile || profile.role === 'supervisor') continue;

    const aliases = new Set([
      group.folder.toLowerCase(),
      group.name.toLowerCase(),
      ...ROLE_LABELS[profile.role],
    ]);

    for (const alias of aliases) {
      if (!promptLower.includes(`delegate to ${alias}`)) continue;
      return group.folder;
    }
  }

  return null;
}

function resolveExplicitCollaborators(
  prompt: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string[] {
  const promptLower = prompt.toLowerCase();
  const matches = new Set<string>();

  for (const group of Object.values(registeredGroups)) {
    const profile = getAdminAgentProfile(group.folder);
    if (!profile || profile.role === 'supervisor') continue;

    for (const alias of ROLE_LABELS[profile.role]) {
      if (
        promptLower.includes(`work with ${alias}`) ||
        promptLower.includes(`coordinate with ${alias}`) ||
        promptLower.includes(`collaborate with ${alias}`)
      ) {
        matches.add(group.folder);
      }
    }
  }

  return [...matches];
}

function confidenceFromMode(mode: SupervisorRouteMode): SupervisorRouteConfidence {
  if (mode === 'delegate') return 'high';
  if (mode === 'collaborate') return 'medium';
  return 'low';
}

function summarizeDecisionReason(decision: {
  mode: SupervisorRouteMode;
  scores: SupervisorRouteScore[];
  overrideReason?: string;
}): string {
  if (decision.overrideReason) return decision.overrideReason;
  const [best, second] = decision.scores;

  if (!best || best.score === 0) {
    return 'No specialist match was strong enough to override direct supervisor handling.';
  }

  if (decision.mode === 'delegate') {
    return `High-confidence specialist match for ${best.role} (${best.score}) over ${
      second ? `${second.role} (${second.score})` : 'no competing role'
    }.`;
  }

  if (decision.mode === 'collaborate') {
    return `Multiple specialist matches were strong enough to suggest collaboration, led by ${best.role}.`;
  }

  return `Supervisor retained direct handling despite a weak ${best.role} signal (${best.score}).`;
}

export function resolveSupervisorRoute(params: {
  group: RegisteredGroup;
  prompt: string;
  registeredGroups: Record<string, RegisteredGroup>;
}): SupervisorRouteDecision {
  if (!isSupervisorGroup(params.group.folder)) {
    return {
      mode: 'self',
      confidence: 'low',
      reason: 'Group is not a supervisor channel.',
      scoreBreakdown: [],
    };
  }

  if (hasExplicitSelfOverride(params.prompt)) {
    return {
      mode: 'self',
      confidence: 'high',
      reason: 'The user explicitly requested direct supervisor handling.',
      scoreBreakdown: [],
    };
  }

  const explicitTarget = resolveExplicitDelegateTarget(
    params.prompt,
    params.registeredGroups,
  );
  if (explicitTarget) {
    return {
      mode: 'delegate',
      confidence: 'high',
      targetGroupFolder: explicitTarget,
      reason: `The user explicitly requested delegation to ${explicitTarget}.`,
      scoreBreakdown: [],
    };
  }

  const explicitCollaborators = resolveExplicitCollaborators(
    params.prompt,
    params.registeredGroups,
  );

  const signals = collectSignals(params.prompt);
  const scores = ROLE_RULES.map((rule) => {
    const targetGroupFolder = resolveTargetFolderForRole(
      rule.role,
      params.registeredGroups,
    );
    if (!targetGroupFolder) {
      return null;
    }

    const result = rule.score(signals);
    return {
      role: rule.role,
      targetGroupFolder,
      score: result.score,
      reasons: result.reasons,
    } satisfies SupervisorRouteScore;
  })
    .filter((entry): entry is SupervisorRouteScore => entry !== null)
    .sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));

  if (explicitCollaborators.length > 0) {
    return {
      mode: 'collaborate',
      confidence: 'medium',
      collaboratorGroupFolders: explicitCollaborators,
      targetGroupFolder: explicitCollaborators[0],
      reason: 'The user explicitly asked the supervisor to coordinate with a specialist.',
      scoreBreakdown: scores,
    };
  }

  const [best, second] = scores;
  if (!best || best.score < 8) {
    return {
      mode: 'self',
      confidence: 'low',
      reason: summarizeDecisionReason({ mode: 'self', scores }),
      scoreBreakdown: scores,
    };
  }

  if (second && best.score >= 6 && second.score >= 6 && best.score - second.score <= 2) {
    return {
      mode: 'collaborate',
      confidence: 'medium',
      targetGroupFolder: best.targetGroupFolder,
      collaboratorGroupFolders: [best.targetGroupFolder, second.targetGroupFolder],
      reason: summarizeDecisionReason({ mode: 'collaborate', scores }),
      scoreBreakdown: scores,
    };
  }

  return {
    mode: 'delegate',
    confidence: confidenceFromMode('delegate'),
    targetGroupFolder: best.targetGroupFolder,
    reason: summarizeDecisionReason({ mode: 'delegate', scores }),
    scoreBreakdown: scores,
  };
}

export function buildSupervisorRoutingPromptPrefix(params: {
  decision: SupervisorRouteDecision;
  registeredGroups: Record<string, RegisteredGroup>;
}): string {
  if (params.decision.mode !== 'collaborate') return '';

  const collaboratorLines = (params.decision.collaboratorGroupFolders ?? [])
    .map((folder) => {
      const group = Object.values(params.registeredGroups).find(
        (candidate) => candidate.folder === folder,
      );
      return group ? `- ${group.name} (${folder})` : `- ${folder}`;
    })
    .join('\n');

  if (!collaboratorLines) return '';

  return (
    '[Supervisor routing hint]\n' +
    `Host routing suggests this task spans multiple specialist domains.\n` +
    `Prefer coordinating with:\n${collaboratorLines}\n` +
    'Delegate the primary execution to the best-fit specialist unless you have a clear reason to handle it directly.\n\n'
  );
}
