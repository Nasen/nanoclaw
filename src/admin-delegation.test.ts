import { describe, expect, it } from 'vitest';

import { resolveDelegationDelivery } from './admin-delegation.js';

describe('resolveDelegationDelivery', () => {
  it('posts supervisor delegations into the target specialist chat', () => {
    const resolved = resolveDelegationDelivery({
      sourceGroupFolder: 'rc-personal',
      sourceGroupName: 'NanoClaw-Personal',
      targetGroupName: 'NanoClaw-GitOps',
      prompt: 'Show today\'s commits for jupiter-video-e2e.',
      result: 'Today\'s commits are:\n- abc123 fix pipeline',
    });

    expect(resolved).toEqual({
      postToTargetChat: true,
      targetChatText:
        '[Delegated from NanoClaw-Personal]\n' +
        'Task: Show today\'s commits for jupiter-video-e2e.\n\n' +
        'Today\'s commits are:\n- abc123 fix pipeline',
      callerResult:
        'The delegated result has already been posted in NanoClaw-GitOps. ' +
        'Do not send any additional RingCentral message to that team for this task. ' +
        'If you reply here, keep it to a brief acknowledgment only.',
      postedToTargetGroup: true,
    });
  });

  it('keeps specialist-to-specialist delegations internal', () => {
    const resolved = resolveDelegationDelivery({
      sourceGroupFolder: 'rc-grp-nanoclaw-gitops',
      sourceGroupName: 'NanoClaw-GitOps',
      targetGroupName: 'NanoClaw-JiraOps',
      prompt: 'Summarize the linked Jira issue.',
      result: '<internal>debug</internal>Jira issue is still open.',
    });

    expect(resolved).toEqual({
      postToTargetChat: false,
      targetChatText: null,
      callerResult: 'Jira issue is still open.',
      postedToTargetGroup: false,
    });
  });

  it('does not post empty delegated results anywhere', () => {
    const resolved = resolveDelegationDelivery({
      sourceGroupFolder: 'rc-personal',
      sourceGroupName: 'NanoClaw-Personal',
      targetGroupName: 'NanoClaw-GitOps',
      prompt: 'Do the thing.',
      result: '   ',
    });

    expect(resolved).toEqual({
      postToTargetChat: false,
      targetChatText: null,
      callerResult: '   ',
      postedToTargetGroup: false,
    });
  });
});
