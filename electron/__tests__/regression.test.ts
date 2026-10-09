/**
 * regression.test.ts — 基线与本次的对比判定。
 *
 * 这个模块唯一的职责是"说实话"，所以用例集中在三件会骗人的事上：
 *   · 把**抖动**当回归（重复采样）；
 *   · 把**缺失**当通过（用例被删掉）；
 *   · 把**不可比**当没变（schema 版本不一致时静默放行）。
 */
import { describe, expect, it } from 'vitest';
import { diffReports, toolSchemaHash, type RegressionKind } from '../agent-eval/regression';
import { projectForBaseline, relativizeEvalPath } from '../agent-eval/report';
import type { EvalCaseRecord, EvalReport } from '../agent-eval/report';

function check(id: string, passed: boolean) {
  return { id, passed, detail: '' };
}

function record(over: Partial<EvalCaseRecord> & { id: string }): EvalCaseRecord {
  return {
    category: 'coding',
    task: 't',
    passed: true,
    score: 1,
    checks: [check('file_contains:src/config.ts', true)],
    checksSpec: null,
    processGates: null,
    tools: null,
    toolMetrics: null,
    verification: { status: 'verified', confidence: 1, evidence: [] } as never,
    changedFiles: [],
    trace: null,
    traceUnavailable: null,
    agentExitOk: true,
    routedModel: null,
    difficulty: null,
    routeReason: null,
    agentStderr: '',
    arm: 'baseline',
    tokensIn: 1000,
    tokensOut: 100,
    ...over,
  };
}

function report(cases: EvalCaseRecord[], mode: EvalReport['mode'] = 'live'): EvalReport {
  return { generatedAt: '2026-01-01T00:00:00.000Z', mode, cases, meta: { schemaVersion: 1 } };
}

const kinds = (r: { regressions: { kind: RegressionKind }[] }) => r.regressions.map((x) => x.kind);

describe('diffReports', () => {
  it('完全相同 → 没有回归、没有改进', () => {
    const base = report([record({ id: 'a' }), record({ id: 'b' })]);
    const out = diffReports(base, report([record({ id: 'a' }), record({ id: 'b' })]));
    expect(out.regressions).toEqual([]);
    expect(out.improvements).toEqual([]);
    expect(out.matches).toMatchObject({ passed: 2, total: 2, tokensIn: 2000, tokensInCommon: 2000 });
  });

  it('用例由过变不过 → case_failed + pass_count_dropped', () => {
    const base = report([record({ id: 'a' }), record({ id: 'b' })]);
    const now = report([record({ id: 'a', passed: false, score: 0.5 }), record({ id: 'b' })]);
    const out = diffReports(base, now);
    expect(kinds(out)).toContain('case_failed');
    expect(kinds(out)).toContain('pass_count_dropped');
    expect(out.regressions.find((r) => r.kind === 'case_failed')?.caseId).toBe('a');
  });

  it('整体还过但某项检查翻了 → check_flipped（比 case 级更早定位）', () => {
    const base = report([record({ id: 'a', checks: [check('file_changed:src/a.ts', true), check('x', true)] })]);
    const now = report([record({ id: 'a', checks: [check('file_changed:src/a.ts', false), check('x', true)] })]);
    const out = diffReports(base, now);
    expect(kinds(out)).toEqual(expect.arrayContaining(['check_flipped']));
    expect(out.regressions.find((r) => r.kind === 'check_flipped')?.detail).toContain('file_changed:src/a.ts');
  });

  it('过程门槛翻单独归类（行为变了 vs 结果变了）', () => {
    const base = report([record({ id: 'a', checks: [check('process:failed-tools', true)] })]);
    const now = report([record({ id: 'a', checks: [check('process:failed-tools', false)] })]);
    expect(kinds(diffReports(base, now))).toContain('process_gate_flipped');
  });

  it('重复采样取**最差**那次：3 次里 1 次失败不算回归（抖动不是退步）', () => {
    const base = report([
      record({ id: 'a', rep: 1, passed: true }),
      record({ id: 'a', rep: 2, passed: true }),
      record({ id: 'a', rep: 3, passed: true }),
    ]);
    const now = report([
      record({ id: 'a', rep: 1, passed: true }),
      record({ id: 'a', rep: 2, passed: false, score: 0 }),
      record({ id: 'a', rep: 3, passed: true }),
    ]);
    const out = diffReports(base, now);
    // 基线 3 次全过（最差=过），本次最差=不过 → 这正是"退化到不稳定"，必须报
    expect(kinds(out)).toContain('case_failed');
  });

  it('基线里有的用例本次没了 → case_missing（删用例不该悄悄发生）', () => {
    const base = report([record({ id: 'a' }), record({ id: 'gone' })]);
    const out = diffReports(base, report([record({ id: 'a' })]));
    expect(kinds(out)).toContain('case_missing');
    expect(out.regressions.find((r) => r.kind === 'case_missing')?.caseId).toBe('gone');
  });

  it('新增用例默认不算回归，但会被列出来', () => {
    const base = report([record({ id: 'a' })]);
    const out = diffReports(base, report([record({ id: 'a' }), record({ id: 'new-one' })]));
    expect(out.regressions).toEqual([]); // 新增用例不该被算成 token 回归
    expect(out.newCases).toEqual(['new-one']);
  });

  /** 可比的成对报告：两边都记了同一个工具 schema 指纹（否则 token 判定会被跳过）。 */
  const comparable = (tokensIn: number) => {
    const r = report([record({ id: 'a', tokensIn })]);
    r.meta.toolSchemaHash = 'sha-abc';
    return r;
  };

  it('token 涨幅在阈值内不报，超过才报', () => {
    const base = comparable(1000);
    expect(kinds(diffReports(base, comparable(1200)))).not.toContain('tokens_increased');
    expect(kinds(diffReports(base, comparable(1400)))).toContain('tokens_increased');
    // 阈值可调（脚本用 --tokens=0.3）
    expect(kinds(diffReports(base, comparable(1250), { maxTokenIncreaseRatio: 0.2 }))).toContain('tokens_increased');
  });

  it('token 下降算改进（对比的两个数之一）', () => {
    const out = diffReports(comparable(10_000), comparable(4_000));
    expect(kinds(out)).not.toContain('tokens_increased');
    expect(out.improvements.some((i) => i.kind === 'tokens_increased')).toBe(true);
    expect(out.matches.tokensIn).toBe(4_000);
  });

  it('验证等级下降单独报（verified → unverified）', () => {
    const base = report([record({ id: 'a', verification: { status: 'verified' } as never })]);
    const now = report([record({ id: 'a', verification: { status: 'unverified' } as never })]);
    expect(kinds(diffReports(base, now))).toContain('verification_downgraded');
  });

  it('schema 版本不一致 → 直接抛错，不假装"没有回归"', () => {
    const base = report([record({ id: 'a' })]);
    const now = report([record({ id: 'a' })]);
    now.meta.schemaVersion = 2;
    expect(() => diffReports(base, now)).toThrow(/schemaVersion/);
  });
});

describe('toolSchemaHash', () => {
  const defs = [
    { name: 'Read', description: 'read a file', input_schema: { type: 'object' } },
    { name: 'Bash', description: 'run a command', input_schema: { type: 'object' } },
  ];

  it('同样的工具表 → 同样的指纹（与对象字面量的键顺序无关）', () => {
    expect(toolSchemaHash(defs)).toBe(toolSchemaHash([...defs]));
  });

  it('描述变了 → 指纹变（它会进缓存前缀）', () => {
    const changed = [defs[0], { ...defs[1], description: 'run a command (v2)' }];
    expect(toolSchemaHash(changed)).not.toBe(toolSchemaHash(defs));
  });

  it('顺序变了也算变（前缀是有序的）', () => {
    expect(toolSchemaHash([...defs].reverse())).not.toBe(toolSchemaHash(defs));
  });

  it('增删工具也算变', () => {
    expect(toolSchemaHash([...defs, { name: 'Edit' }])).not.toBe(toolSchemaHash(defs));
  });
});

describe('token 对比的前提：工具 schema 指纹可比', () => {
  const withHash = (h: string, tokensIn: number) => {
    const r = report([record({ id: 'a', tokensIn })]);
    r.meta.toolSchemaHash = h;
    return r;
  };

  it('两边指纹一致 → 正常比', () => {
    const out = diffReports(withHash('abc', 1000), withHash('abc', 1400));
    expect(out.tokensCompared).toBe(true);
    expect(kinds(out)).toContain('tokens_increased');
  });

  it('基线没记指纹 → 跳过并说明原因（不给"没涨"的假信号）', () => {
    const base = report([record({ id: 'a', tokensIn: 1000 })]);
    const out = diffReports(base, withHash('abc', 99_999));
    expect(out.tokensCompared).toBe(false);
    expect(out.tokensSkippedReason).toContain('基线未记录');
    expect(kinds(out)).not.toContain('tokens_increased');
  });

  it('指纹不一致（工具 schema 变了）→ 跳过并说明', () => {
    const out = diffReports(withHash('abc', 1000), withHash('def', 99_999));
    expect(out.tokensCompared).toBe(false);
    expect(out.tokensSkippedReason).toContain('不可比');
    expect(kinds(out)).not.toContain('tokens_increased');
  });
});

describe('模式必须一致', () => {
  it('dry 报告不与 live 基线比（dry 全是 passed=false，比出来是 100% 假回归）', () => {
    const base = report([record({ id: 'a' })]);
    const dry = report([record({ id: 'a', passed: false })], 'dry');
    expect(() => diffReports(base, dry)).toThrow(/模式不一致/);
  });
});

describe('基线投影', () => {
  it('丢掉轨迹与 stderr，把临时 fixture 绝对路径折回用例内相对路径', () => {
    const raw: EvalReport = report([
      record({
        id: 'coding-001-timeout',
        trace: { turns: [] } as never,
        agentStderr: 'C:\\Users\\someone\\Temp\\boom',
        changedFiles: [
          'C:\\Users\\After\\AppData\\Local\\Temp\\auraxis-eval-coding-001-timeout-lY0Pmz\\src\\config.ts',
          '/tmp/auraxis-eval-coding-001-timeout-abc123/src/app.ts',
        ],
      }),
    ]);
    const frozen = projectForBaseline(raw);
    const c = frozen.cases[0];
    expect(c.trace).toBeNull();
    expect(c.agentStderr).toBe('');
    expect(c.changedFiles).toEqual(['src/config.ts', 'src/app.ts']);
    // 门禁真正读的字段一个不少
    expect(c.passed).toBe(true);
    expect(c.tokensIn).toBe(1000);
  });

  it('认不出用例目录时退回 basename（宁可少信息，也不带机器路径进仓库）', () => {
    expect(relativizeEvalPath('C:\\somewhere\\else\\src\\x.ts', 'coding-002')).toBe('x.ts');
  });
});
