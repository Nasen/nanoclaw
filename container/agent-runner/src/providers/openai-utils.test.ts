import { describe, expect, it } from 'vitest';

import {
  buildTurnMessageDeduplicationKey,
  chooseFinalAssistantOutput,
  containsLegacyToolRefusal,
  hasExplicitOnBehalfRequest,
  isSendConfirmation,
  messagesSubstantiallyOverlap,
  normalizeSendToolArgsForPrompt,
  shouldDropAssistantHistory,
} from './openai-utils.js';

describe('openai-utils', () => {
  it('drops stale RC access failures from assistant history in RC chats', () => {
    expect(
      shouldDropAssistantHistory(
        'I checked for the RingCentral team "Video - All", but I couldn’t find a readable RC chat source in this session.',
        { rcChat: true, personalMode: true },
      ),
    ).toBe(true);
  });

  it('drops legacy tool refusal history', () => {
    expect(
      containsLegacyToolRefusal(
        'This backend does not support NanoClaw tool execution yet.',
      ),
    ).toBe(true);
  });

  it('suppresses final output when it overlaps a send_message delivery', () => {
    const sent =
      'I checked for the RingCentral team Video - All and team ID 132336910342, but I could not find a readable RC chat source in this session.';
    const final =
      'I checked for the RingCentral team "Video - All" and the team ID "132336910342", but I could not find a readable RC chat source in this session to summarize today’s latest message.\n\nIf you can share an export or cache path, I can summarize it right away.';

    expect(messagesSubstantiallyOverlap(sent, final)).toBe(true);
    expect(chooseFinalAssistantOutput(final, [sent])).toEqual({
      outputText: '',
      historyText: sent,
    });
  });

  it('suppresses confirmation-only text after send_message', () => {
    expect(isSendConfirmation('Sent: "I’ll review this today."')).toBe(true);
    expect(
      chooseFinalAssistantOutput('Sent: "I’ll review this today."', [
        'I’ll review this today.',
      ]),
    ).toEqual({
      outputText: '',
      historyText: 'I’ll review this today.',
    });
  });

  it('keeps distinct final output after a progress send_message', () => {
    expect(
      chooseFinalAssistantOutput('The Jenkins job finished successfully.', [
        'Checking Jenkins now.',
      ]),
    ).toEqual({
      outputText: 'The Jenkins job finished successfully.',
      historyText: 'The Jenkins job finished successfully.',
    });
  });

  it('normalizes duplicate send_message calls to the same turn key', () => {
    expect(
      buildTurnMessageDeduplicationKey('send_message', {
        text: '  NotebookLM-related tools I can use here:\n- List notebooks  ',
        delivery_mode: 'personal',
      }),
    ).toBe(
      buildTurnMessageDeduplicationKey('send_message', {
        text: 'NotebookLM-related tools I can use here: - List notebooks',
        delivery_mode: 'personal',
      }),
    );
  });

  it('includes rc chat identity in send_rc_message dedupe keys', () => {
    expect(
      buildTurnMessageDeduplicationKey('send_rc_message', {
        chat_id: 'RC:157530931206',
        text: 'I’ll review this today.',
        mode: 'personal',
      }),
    ).toBe(
      buildTurnMessageDeduplicationKey('send_rc_message', {
        chat_id: 'rc:157530931206',
        text: ' I’ll review this today. ',
        mode: 'personal',
      }),
    );
  });

  it('detects explicit on-behalf phrasing in the latest user request', () => {
    expect(
      hasExplicitOnBehalfRequest(
        'Send this to the Video team on my behalf using my account.',
      ),
    ).toBe(true);
    expect(hasExplicitOnBehalfRequest('Send this to the Video team.')).toBe(
      false,
    );
  });

  it('adds on_behalf_intent to RC send tools for explicit on-behalf requests', () => {
    expect(
      normalizeSendToolArgsForPrompt(
        'send_rc_message',
        {
          chat_id: 'rc:157530931206',
          text: 'I will join in 5 minutes.',
          mode: 'personal',
        },
        'Send this to the Video team on my behalf as me.',
      ),
    ).toEqual({
      chat_id: 'rc:157530931206',
      text: 'I will join in 5 minutes.',
      mode: 'personal',
      on_behalf_intent: true,
    });
  });

  it('leaves normal RC send tool args unchanged without explicit on-behalf phrasing', () => {
    const args = {
      chat_id: 'rc:157530931206',
      text: 'Build passed.',
      mode: 'bot',
    };

    expect(
      normalizeSendToolArgsForPrompt(
        'send_rc_message',
        args,
        'Send this to the Video team.',
      ),
    ).toEqual(args);
  });
});
