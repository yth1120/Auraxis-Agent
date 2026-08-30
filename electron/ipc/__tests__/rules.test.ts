import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { parsePrefixRule, loadRules, matchRule } from '../../rules';

let rulesRoot: string;
let projectRoot: string;

beforeEach(async () => {
  rulesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-rules-'));
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-rules-proj-'));
  process.env.AURAXIS_RULES_DIR = rulesRoot;
});

afterEach(async () => {
  delete process.env.AURAXIS_RULES_DIR;
  delete process.env.AURAXIS_TRUST_PROJECT_RULES;
  await fs.rm(rulesRoot, { recursive: true, force: true });
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe('rules', () => {
  it('parses a prefix_rule block', () => {
    const rule = parsePrefixRule(
      'prefix_rule(\n  pattern = ["gh", "pr", "view"],\n  decision = "prompt",\n  justification = "查看 PR 需要确认"\n)',
      'test.rules',
    );
    expect(rule?.pattern).toEqual(['gh', 'pr', 'view']);
    expect(rule?.decision).toBe('prompt');
    expect(rule?.justification).toBe('查看 PR 需要确认');
  });

  it('project rules stay inert unless explicitly trusted', async () => {
    await fs.mkdir(rulesRoot, { recursive: true });
    await fs.writeFile(
      path.join(rulesRoot, 'default.rules'),
      'prefix_rule(\n  pattern = ["git", "push"],\n  decision = "prompt"\n)',
      'utf8',
    );
    await fs.mkdir(path.join(projectRoot, '.auraxis', 'rules'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.auraxis', 'rules', 'project.rules'),
      'prefix_rule(\n  pattern = ["npm", "publish"],\n  decision = "deny"\n)',
      'utf8',
    );
    const defaultRules = await loadRules(projectRoot);
    expect(defaultRules).toHaveLength(1);

    process.env.AURAXIS_TRUST_PROJECT_RULES = '1';
    const trustedRules = await loadRules(projectRoot);
    expect(trustedRules).toHaveLength(2);
  });

  it('matches exact command prefixes in order', () => {
    const rules = [
      { pattern: ['gh', 'pr', 'view'], decision: 'allow' as const, source: 'a' },
      { pattern: ['gh'], decision: 'deny' as const, source: 'b' },
    ];
    expect(matchRule('gh pr view 7888', rules)?.decision).toBe('allow');
    expect(matchRule('gh repo list', rules)?.decision).toBe('deny');
    expect(matchRule('npm test', rules)).toBeNull();
  });
});
