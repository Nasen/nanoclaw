import { describe, expect, it } from 'vitest';

import {
  canAdminAgentDelegate,
  canAdminAgentSpeakAsOwner,
  getAdminAgentProfile,
  getAdminAgentPromptHeader,
  hasAdminAgentToolAccess,
} from './admin-agents.js';

describe('admin agent profiles', () => {
  it('resolves rc-personal as the supervisor and owner-voice channel', () => {
    const profile = getAdminAgentProfile('rc-personal');

    expect(profile).toMatchObject({
      role: 'supervisor',
      canSpeakAsOwner: true,
      mountProfile: 'supervisor',
    });
    expect(hasAdminAgentToolAccess('rc-personal', 'delegate_to_group')).toBe(
      true,
    );
    expect(hasAdminAgentToolAccess('rc-personal', 'send_rc_message')).toBe(
      true,
    );
    expect(canAdminAgentSpeakAsOwner('rc-personal')).toBe(true);
    expect(profile?.envKeys).toContain('TESTIT_ACCESS_TOKEN');
  });

  it('resolves GitOps as a scoped specialist without owner voice', () => {
    const profile = getAdminAgentProfile('rc-grp-nanoclaw-gitops');

    expect(profile).toMatchObject({
      role: 'gitops',
      canSpeakAsOwner: false,
      mountProfile: 'projects-readwrite',
      allowGitAuth: true,
    });
    expect(profile?.externalMcpCapabilities).toContain('gitlab');
    expect(
      hasAdminAgentToolAccess('rc-grp-nanoclaw-gitops', 'delegate_to_group'),
    ).toBe(true);
    expect(
      hasAdminAgentToolAccess('rc-grp-nanoclaw-gitops', 'send_rc_message'),
    ).toBe(false);
    expect(canAdminAgentSpeakAsOwner('rc-grp-nanoclaw-gitops')).toBe(false);
  });

  it('enforces allowed peer delegation rules', () => {
    expect(
      canAdminAgentDelegate(
        'rc-grp-nanoclaw-gitops',
        'rc-grp-nanoclaw-jiraops',
      ),
    ).toBe(true);
    expect(
      canAdminAgentDelegate(
        'rc-grp-nanoclaw-peopleops',
        'rc-grp-nanoclaw-gitops',
      ),
    ).toBe(false);
  });

  it('builds a role-specific prompt header for specialists', () => {
    const header = getAdminAgentPromptHeader({
      name: 'NanoClaw-GitOps',
      folder: 'rc-grp-nanoclaw-gitops',
      trigger: '@NanoClaw',
      added_at: '2026-03-31T00:00:00.000Z',
    });

    expect(header).toContain('Admin agent role: gitops');
    expect(header).toContain('not as Nasen');
    expect(header).toContain('delegate_to_group');
  });

  it('passes TestIt credentials only to TestIt-capable specialist roles', () => {
    const automation = getAdminAgentProfile('rc-grp-nanoclaw-test-automation');
    const design = getAdminAgentProfile('rc-grp-nanoclaw-test-design');
    const gitops = getAdminAgentProfile('rc-grp-nanoclaw-gitops');

    expect(automation?.externalMcpCapabilities).toContain('testit');
    expect(design?.externalMcpCapabilities).toContain('testit');
    expect(automation?.envKeys).toContain('TESTIT_ACCESS_TOKEN');
    expect(design?.envKeys).toContain('TESTIT_ACCESS_TOKEN');
    expect(gitops?.externalMcpCapabilities).not.toContain('testit');
    expect(gitops?.envKeys).not.toContain('TESTIT_ACCESS_TOKEN');
  });
});
