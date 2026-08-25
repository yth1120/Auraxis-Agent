/**
 * skill-gate.ts — When Self-Evolution Backfires 的 Verifier-as-Gatekeeper.
 *
 * 论文核心：技能池超过临界规模后新增技能会污染后续蒸馏链，且污染结构性
 * 不可逆（删掉源头技能也无法修复后代），因此技能入库必须是 pre-commit
 * 门禁，而不是事后回滚。
 *
 * 本实现提供三道异构批评：
 *  1. 结构有效性（frontmatter / 名称 / 正文长度）
 *  2. 行为无害性（危险命令模式）
 *  3. 语义一致性（描述是否占位符、与名称是否相符）
 * 以及边际增益子集选择（去重 + 多样性 + 新鲜度）。
 */

export interface SkillLike {
  name: string;
  description?: string;
  updatedAt?: number;
}

export interface SkillGateResult {
  blocking: string[];
  warnings: string[];
  pass: boolean;
}

const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+-(?:rf|fr)\s+(?:\/|~|\*)/i,
  /format\s+[a-z]:\s*\/?(?:\/q)?/i,
  /\bmkfs(?:\s|\.)/i,
  /\bdd\s+if=.*of=\/dev\//i,
  />\s*\/dev\/sd[a-z]/i,
  /\brd\s+\/s\s+\/q\s+[a-z]:/i,
  /\bdel\s+\/f\s+\/s\s+\/q\s+[a-z]:/i,
  /\bshutdown\s+\/s/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*:/,
];

function bodyWithoutFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\s*/, '').trim();
}

function frontmatterField(content: string, field: string): string | null {
  const re = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm');
  const m = content.match(re);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/** 三道批评 + 硬性阻断。blocking 拒绝入库；warnings 允许入库但需提示。 */
export function validateSkill(name: string, content: string): SkillGateResult {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const trimmedName = name.trim();
  const trimmedContent = content.trim();

  // ── 结构有效性 ──
  if (!trimmedName) blocking.push('技能名称不能为空');
  if (trimmedName.length > 48) blocking.push('技能名称过长（>48 字符）');
  if (!trimmedContent) blocking.push('技能内容不能为空');
  if (bodyWithoutFrontmatter(trimmedContent).length < 20) {
    blocking.push('技能正文过短（<20 字符）');
  }
  const fmName = frontmatterField(trimmedContent, 'name');
  const fmDesc = frontmatterField(trimmedContent, 'description');
  if (!trimmedContent.startsWith('---')) warnings.push('缺少 frontmatter，将自动补充 name/description');
  else if (!fmName) warnings.push('frontmatter 缺少 name 字段');

  // ── 行为无害性 ──
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(trimmedContent)) {
      blocking.push(`正文包含危险命令模式：${re.source.slice(0, 70)}`);
    }
  }

  // ── 语义一致性 ──
  const desc = fmDesc ?? '';
  if (!desc) warnings.push('缺少 description，建议写清何时使用该技能');
  else if (desc === trimmedName || desc.endsWith(' 技能')) {
    warnings.push('description 疑似占位符，建议描述具体使用场景');
  }
  if (
    desc &&
    trimmedName &&
    !desc.toLowerCase().includes(trimmedName.toLowerCase()) &&
    !trimmedName.toLowerCase().includes(desc.toLowerCase())
  ) {
    warnings.push('description 与名称语义不一致，请确认描述准确');
  }

  return { blocking, warnings, pass: blocking.length === 0 };
}

function tokenSet(s: SkillLike): Set<string> {
  const text = `${s.name} ${s.description ?? ''}`.toLowerCase();
  return new Set(text.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 边际增益子集选择：贪心选"与已选集合最不相似 + 最新"的技能，
 * 用于控制技能池规模，避免组合污染。
 */
export function selectSkillSubset(skills: SkillLike[], max: number): string[] {
  if (max <= 0 || skills.length === 0) return [];
  const pool = [...skills];
  const selected: SkillLike[] = [];
  const ts = pool.map((s) => s.updatedAt ?? 0);
  const maxTs = Math.max(...ts, 1);
  const minTs = Math.min(...ts, 0);

  while (selected.length < max && pool.length > 0) {
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      const tokens = tokenSet(s);
      const maxSim = selected.length === 0 ? 0 : Math.max(...selected.map((sel) => jaccard(tokens, tokenSet(sel))));
      const diversity = 1 - maxSim;
      const recency = (ts[i] - minTs) / (maxTs - minTs || 1);
      const score = 0.7 * diversity + 0.3 * recency;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    selected.push(pool[bestIdx]);
    pool.splice(bestIdx, 1);
  }
  return selected.map((s) => s.name);
}
