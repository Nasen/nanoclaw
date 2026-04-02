import { describe, expect, it } from 'vitest';

import {
  buildSupervisorRoutingPromptPrefix,
  resolveSupervisorRoute,
} from './supervisor-routing.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(
  folder: string,
  name = folder,
  jid = `${folder}@chat`,
): [string, RegisteredGroup] {
  return [
    jid,
    {
      name,
      folder,
      trigger: '@NanoClaw',
      added_at: new Date().toISOString(),
    },
  ];
}

function makeRegisteredGroups(): Record<string, RegisteredGroup> {
  return Object.fromEntries([
    makeGroup('rc-personal', 'NanoClaw-Personal', 'rcb:157530931206'),
    makeGroup(
      'rc-grp-nanoclaw-test-automation',
      'NanoClaw-Test Automation',
      'rcb:158812815366',
    ),
    makeGroup(
      'rc-grp-nanoclaw-test-design',
      'NanoClaw-Test Design',
      'rcb:158812807174',
    ),
    makeGroup(
      'rc-grp-nanoclaw-jiraops',
      'NanoClaw-JiraOps',
      'rcb:158813085702',
    ),
    makeGroup('rc-grp-nanoclaw-ciops', 'NanoClaw-CIOps', 'rcb:158813724678'),
    makeGroup('rc-grp-nanoclaw-gitops', 'NanoClaw-GitOps', 'rcb:158812848134'),
    makeGroup(
      'rc-grp-nanoclaw-feature-development',
      'NanoClaw-Feature Development',
      'rcb:158812790790',
    ),
  ]);
}

describe('resolveSupervisorRoute', () => {
  it('delegates strong test automation implementation requests to Test Automation', () => {
    const registeredGroups = makeRegisteredGroups();
    const personal = registeredGroups['rcb:157530931206'];

    const decision = resolveSupervisorRoute({
      group: personal,
      prompt:
        'Implement test case automation for TestIT case NRCV-15763 in jupiter-video-e2e repo with existing skills.',
      registeredGroups,
    });

    expect(decision.mode).toBe('delegate');
    expect(decision.targetGroupFolder).toBe('rc-grp-nanoclaw-test-automation');
    expect(decision.confidence).toBe('high');
  });

  it('keeps the work in rc-personal when the user explicitly forbids delegation', () => {
    const registeredGroups = makeRegisteredGroups();
    const personal = registeredGroups['rcb:157530931206'];

    const decision = resolveSupervisorRoute({
      group: personal,
      prompt:
        'Implement test case automation for TestIT case NRCV-15763, but handle it directly and do not delegate.',
      registeredGroups,
    });

    expect(decision.mode).toBe('self');
    expect(decision.confidence).toBe('high');
  });

  it('honors explicit delegation targets', () => {
    const registeredGroups = makeRegisteredGroups();
    const personal = registeredGroups['rcb:157530931206'];

    const decision = resolveSupervisorRoute({
      group: personal,
      prompt:
        'Delegate to NanoClaw-GitOps and have them prepare the branch and MR for jupiter-video-e2e.',
      registeredGroups,
    });

    expect(decision.mode).toBe('delegate');
    expect(decision.targetGroupFolder).toBe('rc-grp-nanoclaw-gitops');
    expect(decision.confidence).toBe('high');
  });

  it('suggests collaboration when multiple specialist domains are similarly strong', () => {
    const registeredGroups = makeRegisteredGroups();
    const personal = registeredGroups['rcb:157530931206'];

    const decision = resolveSupervisorRoute({
      group: personal,
      prompt:
        'Coordinate CI pipeline triage and Jira backlog updates for the release blockers.',
      registeredGroups,
    });

    expect(decision.mode).toBe('collaborate');
    expect(decision.targetGroupFolder).toBe('rc-grp-nanoclaw-ciops');
    expect(decision.collaboratorGroupFolders).toContain(
      'rc-grp-nanoclaw-jiraops',
    );
    expect(
      buildSupervisorRoutingPromptPrefix({
        decision,
        registeredGroups,
      }),
    ).toContain('NanoClaw-JiraOps');
  });
});
