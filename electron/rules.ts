/**
 * rules.ts — prefix rules for command-level permission decisions.
 *
 * Files: <userData>/rules/*.rules and <project>/.auraxis/rules/*.rules.
 * 语法（前缀规则）：
 *   prefix_rule(
 *     pattern = ["gh", "pr", "view"],
 *     decision = "prompt",   // allow | deny | prompt
 *     justification = "..."
 *   )
 */
import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';

export type RuleDecision = 'allow' | 'deny' | 'prompt';

export interface PrefixRule {
  pattern: string[];
  decision: RuleDecision;
  justification?: string;
  source: string;
}

function rulesDir(): string {
  if (process.env.AURAXIS_RULES_DIR) return process.env.AURAXIS_RULES_DIR;
  return path.join(app.getPath('userData'), 'rules');
}

/**
 * Project-owned `.auraxis/rules/*.rules` can contain `decision = "allow"` and
 * would otherwise let an untrusted repository grant itself permission to run
 * commands. Keep them inert unless the operator explicitly trusts project
 * rules (mirrors the project-hooks trust switch).
 */
function projectRulesTrusted(): boolean {
  return process.env.AURAXIS_TRUST_PROJECT_RULES === '1';
}

function parseDecision(raw: string): RuleDecision {
  const v = raw.toLowerCase();
  if (v === 'allow' || v === 'deny' || v === 'prompt') return v;
  return 'prompt';
}

/** Parse one prefix_rule(...) block. */
export function parsePrefixRule(block: string, source: string): PrefixRule | null {
  const patternMatch = block.match(/pattern\s*=\s*\[([^\]]*)\]/);
  const decisionMatch = block.match(/decision\s*=\s*"([^"]+)"/);
  const justMatch = block.match(/justification\s*=\s*"([^"]+)"/);
  if (!patternMatch || !decisionMatch) return null;
  const pattern = patternMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, ''))
    .filter(Boolean);
  if (pattern.length === 0) return null;
  return {
    pattern,
    decision: parseDecision(decisionMatch[1]),
    justification: justMatch?.[1],
    source,
  };
}

async function loadRulesFromFile(file: string): Promise<PrefixRule[]> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const rules: PrefixRule[] = [];
    let start = raw.indexOf('prefix_rule(');
    while (start >= 0) {
      const end = raw.indexOf(')', start);
      if (end < 0) break;
      const block = raw.slice(start, end + 1);
      const rule = parsePrefixRule(block, file);
      if (rule) rules.push(rule);
      start = raw.indexOf('prefix_rule(', end);
    }
    return rules;
  } catch {
    return [];
  }
}

async function loadRulesFromDir(dir: string): Promise<PrefixRule[]> {
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const rules: PrefixRule[] = [];
  for (const file of files) {
    if (!file.endsWith('.rules')) continue;
    rules.push(...(await loadRulesFromFile(path.join(dir, file))));
  }
  return rules;
}

export async function loadRules(projectRoot?: string): Promise<PrefixRule[]> {
  const rules = await loadRulesFromDir(rulesDir());
  if (projectRoot && projectRulesTrusted()) {
    rules.push(...(await loadRulesFromDir(path.join(projectRoot, '.auraxis', 'rules'))));
  }
  return rules;
}

/** First rule whose pattern is an exact prefix of the command tokens. */
export function matchRule(command: string, rules: PrefixRule[]): PrefixRule | null {
  const tokens = command.trim().split(/\s+/);
  for (const rule of rules) {
    if (rule.pattern.length > tokens.length) continue;
    let hit = true;
    for (let i = 0; i < rule.pattern.length; i++) {
      if (tokens[i] !== rule.pattern[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return rule;
  }
  return null;
}
