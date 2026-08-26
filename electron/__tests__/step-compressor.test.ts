import { describe, it, expect } from 'vitest';
import {
  compressHistorySteps,
  groupIntoSteps,
  isCriticalStep,
  scoreStep,
  buildStepSummary,
  type StepGroup,
} from '../step-compressor';

function anthropicStep(text: string, toolName: string, toolInput: any, resultText: string): any[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text },
        { type: 'tool_use', id: `tu-${toolName}`, name: toolName, input: toolInput },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `tu-${toolName}`, content: resultText }],
    },
  ];
}

function plan() {
  return { tasks: [{ status: 'pending', description: 'fix src/app.ts module', toolMatches: [] }] };
}

describe('step-compressor（AGORA）', () => {
  it('按完整步骤分组，不拆分 assistant 与 tool_result', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      ...anthropicStep(
        't1',
        'Read',
        { file_path: 'src/app.ts' },
        '{"file_path":"src/app.ts","content":"x","total_lines":20}',
      ),
      ...anthropicStep('t2', 'Bash', { command: 'npm test' }, '{"passed":true}'),
    ];
    const { system, steps } = groupIntoSteps(messages);
    expect(system).toHaveLength(1);
    expect(steps).toHaveLength(2);
    expect(steps[0].tail).toHaveLength(1);
  });

  it('保留最近 K 步，中间步骤整步丢弃并生成摘要', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      ...anthropicStep('round1', 'Grep', { pattern: 'x' }, 'no match'),
      ...anthropicStep('round2', 'Read', { file_path: 'src/app.ts' }, 'content'),
      ...anthropicStep('round3', 'Edit', { file_path: 'src/app.ts' }, 'ok'),
    ];
    const result = compressHistorySteps(messages, { keepRecentSteps: 2, plan: plan() });
    expect(result[0]).toEqual({ role: 'system', content: 'sys' });
    const summaryIdx = result.findIndex(
      (m: any) => typeof m.content === 'string' && m.content.startsWith('[历史上下文摘要]'),
    );
    expect(summaryIdx).toBeGreaterThan(0);
    expect(result.some((m: any) => m.STEP_COMPRESSED)).toBe(true);
    // 最近两步（round2/round3）的 assistant 与 tool_result 必须成对出现。
    const round3 = result.filter((m: any) => m.role === 'assistant' && JSON.stringify(m).includes('round3'));
    expect(round3).toHaveLength(1);
    const round3Idx = result.indexOf(round3[0]);
    expect(result[round3Idx + 1].role).toBe('user');
  });

  it('计划相关的关键步骤被救回，不被压缩', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      ...anthropicStep(
        '关键读取',
        'Read',
        { file_path: 'src/app.ts' },
        '{"file_path":"src/app.ts","content":"x","total_lines":20}',
      ),
      ...anthropicStep('普通', 'Grep', { pattern: 'y' }, 'nothing'),
      ...anthropicStep('最近', 'Bash', { command: 'npm test' }, 'pass'),
    ];
    const result = compressHistorySteps(messages, { keepRecentSteps: 1, plan: plan() });
    expect(result.some((m: any) => JSON.stringify(m).includes('关键读取'))).toBe(true);
    // 被压缩的普通步骤不应出现在最终消息中（只存在于摘要里）。
    expect(result.some((m: any) => JSON.stringify(m).includes('普通'))).toBe(false);
  });

  it('isCriticalStep 识别 Replan 与计划文件写入', () => {
    const replan: StepGroup = {
      assistant: { role: 'assistant', content: [{ type: 'tool_use', id: 'r', name: 'Replan', input: {} }] },
      tail: [],
    };
    expect(isCriticalStep(replan, plan())).toBe(true);
    const write: StepGroup = {
      assistant: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: 'src/app.ts' } }],
      },
      tail: [],
    };
    expect(isCriticalStep(write, plan())).toBe(true);
    const grep: StepGroup = {
      assistant: { role: 'assistant', content: [{ type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'x' } }] },
      tail: [],
    };
    expect(isCriticalStep(grep, plan())).toBe(false);
  });

  it('scoreStep 给错误结果与重要工具更高分', () => {
    const err = anthropicStep('t', 'Bash', { command: 'npm test' }, 'error: fail');
    const ok = anthropicStep('t', 'Bash', { command: 'npm test' }, 'pass');
    const [errStep] = groupIntoSteps(err).steps;
    const [okStep] = groupIntoSteps(ok).steps;
    expect(scoreStep(errStep, plan())).toBeGreaterThan(scoreStep(okStep, plan()));
  });

  it('buildStepSummary 汇总文件与命令', () => {
    const messages = anthropicStep('t', 'Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }, 'ok');
    const { steps } = groupIntoSteps(messages);
    const summary = buildStepSummary(steps, plan());
    expect(summary).toContain('src/app.ts');
    expect(summary).toContain('已压缩 1 个中间步骤');
  });

  it('不修改原数组', () => {
    const messages = [
      ...anthropicStep('r1', 'Grep', { pattern: 'x' }, 'no'),
      ...anthropicStep('r2', 'Read', { file_path: 'src/app.ts' }, 'c'),
      ...anthropicStep('r3', 'Bash', { command: 'npm test' }, 'pass'),
    ];
    const before = JSON.stringify(messages);
    compressHistorySteps(messages, { keepRecentSteps: 2 });
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('支持 OpenAI tool_calls 格式并保护成对结构', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"pattern":"x","results":[]}' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c2', type: 'function', function: { name: 'Read', arguments: '{"file_path":"src/app.ts"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c2', content: '{"file_path":"src/app.ts","content":"x","total_lines":20}' },
      { role: 'assistant', content: '最近一轮', tool_calls: [] },
    ];
    const result = compressHistorySteps(messages, { keepRecentSteps: 2, plan: plan() });
    // 第二轮 Read 命中计划 → 关键步骤被救回；第一轮 Grep 被整步压缩。
    expect(result.some((m) => JSON.stringify(m).includes('c2'))).toBe(true);
    expect(result.some((m) => JSON.stringify(m).includes('c1'))).toBe(false);
  });

  it('保留系统/前导注入与首条用户消息', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '你的任务计划已获批准：step1' },
      { role: 'user', content: '原始请求' },
      ...anthropicStep('r1', 'Grep', { pattern: 'x' }, 'no'),
      ...anthropicStep('r2', 'Bash', { command: 'npm test' }, 'pass'),
      ...anthropicStep('r3', 'Bash', { command: 'npm run build' }, 'ok'),
    ];
    const result = compressHistorySteps(messages, { keepRecentSteps: 2 });
    expect(result[0]).toEqual({ role: 'system', content: 'sys' });
    expect(result[1].content).toContain('你的任务计划');
    expect(result[2].content).toBe('原始请求');
  });

  it('步骤数不超过地板时原样返回同一数组', () => {
    const messages = [...anthropicStep('a', 'Grep', { pattern: 'x' }, 'no')];
    expect(compressHistorySteps(messages, { keepRecentSteps: 3 })).toBe(messages);
  });

  it('Grep 结果命中计划文件时步骤为关键步骤', () => {
    const messages = anthropicStep('g', 'Grep', { pattern: 'x' }, '{"pattern":"x","results":[{"file":"src/app.ts"}]}');
    const { steps } = groupIntoSteps(messages);
    expect(isCriticalStep(steps[0], plan())).toBe(true);
  });

  it('covers helper edge cases and summary fallbacks', () => {
    const rawAssistant = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'x', type: 'function', function: { name: 'Bash', arguments: { command: 'x' } } },
        { id: 'y', type: 'function', function: { name: 'Read', arguments: '{"file_path":"src/app.ts"}' } },
        { id: 'z', type: 'function', function: { name: 'Read', arguments: '{bad' } },
        { id: 'w', type: 'function', function: { name: 'Write', arguments: '{"file_path":"src/app.ts"}' } },
      ],
    } as never;
    const { steps } = groupIntoSteps([
      rawAssistant,
      { role: 'tool', content: '{"pattern":"x","results":[{"file":"src/app.ts"}]}' },
    ]);
    expect(steps).toHaveLength(1);
    const directWrite = {
      assistant: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { path: 'src/app.ts' } }],
      },
      tail: [],
    } as never;
    expect(isCriticalStep(directWrite, plan())).toBe(true);
    expect(isCriticalStep({ assistant: { role: 'assistant', content: [] }, tail: [] } as never, null)).toBe(false);

    const errorStep = {
      assistant: { role: 'assistant', content: 'x' },
      tail: [{ role: 'user', content: [{ type: 'tool_result', content: 'FAILED' }] }],
    } as never;
    expect(scoreStep(errorStep, null)).toBeGreaterThan(0);
    expect(scoreStep({ assistant: { role: 'assistant', content: 'x' }, tail: [] } as never, null)).toBe(0);

    const summary = buildStepSummary([], plan(), '[摘要]');
    expect(summary).toContain('[摘要]');
    expect(summary).toContain('中间步骤无关键信息');
    const noPending = buildStepSummary([], { tasks: [{ status: 'completed', description: 'done' }] });
    expect(noPending).not.toContain('剩余计划任务');
  });

  it('compresses with default options and preserves custom header/orphans', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '用户原始请求' },
      { role: 'tool', content: '孤儿工具结果' },
      ...anthropicStep(
        'r1',
        'Read',
        { file_path: 'src/app.ts' },
        '{"file_path":"src/app.ts","content":"x","total_lines":8}',
      ),
      ...anthropicStep('r2', 'Write', { file_path: 'src/app.ts' }, 'ok'),
      ...anthropicStep('r3', 'Grep', { pattern: 'x' }, 'no'),
    ];
    const result = compressHistorySteps(messages, { keepRecentSteps: 0, summaryHeader: '[自定义]', plan: plan() });
    expect(result.some((m) => String(m.content).includes('[自定义]'))).toBe(true);
    expect(result.some((m) => m.role === 'tool')).toBe(true); // orphan
    const withNull = compressHistorySteps([{ role: 'assistant', content: null, tool_calls: null as never }], {
      keepRecentSteps: 1,
    });
    expect(withNull).toHaveLength(1);
  });
});
