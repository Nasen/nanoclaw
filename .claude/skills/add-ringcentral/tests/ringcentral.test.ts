import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('ringcentral skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: ringcentral');
    expect(content).toContain('@ringcentral/sdk');
    expect(content).toContain('RC_BOT_TOKEN');
  });

  it('has the declared added files', () => {
    const channelFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'ringcentral.ts',
    );
    expect(fs.existsSync(channelFile)).toBe(true);

    const channelContent = fs.readFileSync(channelFile, 'utf-8');
    expect(channelContent).toContain('export class RingCentralChannel');
    expect(channelContent).toContain("jidPrefix ?? 'rc:'");
    expect(channelContent).toContain('autoRegister');

    const autoRegisterFile = path.join(
      skillDir,
      'add',
      'src',
      'rc-auto-register.ts',
    );
    expect(fs.existsSync(autoRegisterFile)).toBe(true);

    const autoRegisterContent = fs.readFileSync(autoRegisterFile, 'utf-8');
    expect(autoRegisterContent).toContain('export function autoRegisterContact');
    expect(autoRegisterContent).toContain('rc-grp-');
  });

  it('has the declared modified files and intent docs', () => {
    const modifiedFiles = [
      'index.ts',
      'channel-bootstrap.ts',
      'container-config.ts',
      'group-agent-runner.ts',
      'message-gating.ts',
    ];

    for (const file of modifiedFiles) {
      expect(
        fs.existsSync(path.join(skillDir, 'modify', 'src', file)),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(skillDir, 'modify', 'src', `${file}.intent.md`),
        ),
      ).toBe(true);
    }
  });

  it('documents the contributor workflow in SKILL.md', () => {
    const skillDoc = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillDoc).toContain('scripts/apply-skill.ts');
    expect(skillDoc).toContain('rcb:');
    expect(skillDoc).toContain('groups/direct-contacts.json');
  });
});
