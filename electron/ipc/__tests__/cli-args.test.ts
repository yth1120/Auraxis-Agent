import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../../cli-args';

describe('cli-args', () => {
  it('parses help / sdk / acp flags', () => {
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs(['--sdk']).sdk).toBe(true);
    expect(parseCliArgs(['--acp']).acp).toBe(true);
  });

  it('parses --run with space or equals syntax', () => {
    expect(parseCliArgs(['--run', 'hello']).run).toBe('hello');
    expect(parseCliArgs(['--run=hello world']).run).toBe('hello world');
  });

  it('parses --plugin list', () => {
    expect(parseCliArgs(['--plugin', 'list']).pluginList).toBe(true);
    expect(parseCliArgs(['--plugin', 'enable', 'x']).pluginList).toBe(false);
  });

  it('parses --plugin scan / enable / disable', () => {
    expect(parseCliArgs(['--plugin', 'scan', 'C:/plugins']).pluginScanDir).toBe('C:/plugins');
    expect(parseCliArgs(['--plugin', 'enable', 'demo']).pluginEnable).toBe('demo');
    expect(parseCliArgs(['--plugin', 'disable', 'demo']).pluginDisable).toBe('demo');
  });

  it('parses task options', () => {
    const args = parseCliArgs([
      '--run',
      '修复 bug',
      '--project',
      'C:/proj',
      '--model',
      'deepseek-v4-flash',
      '--api-key',
      'sk-test',
      '--api-base',
      'http://127.0.0.1:9999/v1/chat/completions',
      '--mode',
      'plan',
      '--sandbox',
      'read',
      '--deep-think',
      '--reasoning-effort',
      'max',
      '--max-iterations',
      '12',
      '--json',
      '--verbose',
      '--auto-approve',
      '--approve-plan',
    ]);
    expect(args.run).toBe('修复 bug');
    expect(args.project).toBe('C:/proj');
    expect(args.model).toBe('deepseek-v4-flash');
    expect(args.apiKey).toBe('sk-test');
    expect(args.apiBase).toBe('http://127.0.0.1:9999/v1/chat/completions');
    expect(args.mode).toBe('plan');
    expect(args.sandbox).toBe('read');
    expect(args.deepThink).toBe(true);
    expect(args.reasoningEffort).toBe('max');
    expect(args.maxIterations).toBe(12);
    expect(args.json).toBe(true);
    expect(args.verbose).toBe(true);
    expect(args.autoApprove).toBe(true);
    expect(args.approvePlan).toBe(true);
  });

  it('parses --tool-choice（auto/none/required/工具名）', () => {
    expect(parseCliArgs(['--run', 'x', '--tool-choice', 'required']).toolChoice).toBe('required');
    expect(parseCliArgs(['--run', 'x', '--tool-choice', 'none']).toolChoice).toBe('none');
    expect(parseCliArgs(['--run', 'x', '--tool-choice', 'WebSearch']).toolChoice).toEqual({
      type: 'function',
      function: { name: 'WebSearch' },
    });
  });

  it('supports --flag=value syntax and rejects bad enums', () => {
    const args = parseCliArgs(['--run=hello', '--project=C:/x', '--max-iterations=abc', '--mode=wat', '--sandbox=wat']);
    expect(args.run).toBe('hello');
    expect(args.project).toBe('C:/x');
    expect(args.maxIterations).toBeUndefined();
    expect(args.mode).toBeUndefined();
    expect(args.sandbox).toBeUndefined();
  });

  it('normalizes legacy --mode afe to auto', () => {
    const args = parseCliArgs(['--run', 'x', '--mode', 'afe']);
    expect(args.mode).toBe('auto');
  });
});
