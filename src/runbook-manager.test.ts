import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  promoteSkillCandidateToRunbook,
  upsertGroupRunbook,
} from './runbook-manager.js';

const groupDir = path.join(process.cwd(), 'groups', 'other-group');
const runbooksDir = path.join(groupDir, 'runbooks');

afterEach(() => {
  fs.rmSync(runbooksDir, { recursive: true, force: true });
});

describe('runbook-manager', () => {
  it('promotes a skill candidate into a runbook and updates the index', () => {
    const candidate = upsertGroupRunbook({
      groupFolder: 'other-group',
      kind: 'skill_candidate',
      title: 'Deploy recovery',
      summary: 'Draft recovery checklist.',
      body: '1. Verify the image tag.\n2. Rebuild the container image.\n',
    });

    const result = promoteSkillCandidateToRunbook({
      groupFolder: 'other-group',
      candidatePath: candidate.relativePath,
      summary: 'Approved recovery checklist.',
    });

    expect(result.relativePath).toBe('deploy-recovery.md');
    expect(fs.existsSync(path.join(runbooksDir, 'deploy-recovery.md'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(runbooksDir, candidate.relativePath))).toBe(
      false,
    );

    const index = fs.readFileSync(path.join(runbooksDir, 'index.md'), 'utf-8');
    expect(index).toContain('`deploy-recovery.md`');
    expect(index).not.toContain('`skill-candidates/deploy-recovery.md`');

    const runbook = fs.readFileSync(
      path.join(runbooksDir, 'deploy-recovery.md'),
      'utf-8',
    );
    expect(runbook).toContain('Approved recovery checklist.');
    expect(runbook).toContain('1. Verify the image tag.');
    expect(runbook.match(/Draft recovery checklist\./g) ?? []).toHaveLength(0);
  });

  it('rejects candidate promotion paths that escape the skill-candidates directory', () => {
    expect(() =>
      promoteSkillCandidateToRunbook({
        groupFolder: 'other-group',
        candidatePath: 'skill-candidates/../../../../.env',
      }),
    ).toThrow('Invalid skill candidate path');
  });
});
