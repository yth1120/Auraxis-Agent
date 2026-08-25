import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { safeProcessEnv, unsafeCodeEnabled } from '../safe-env';
import { commandMutates, enforceSandbox } from '../sandbox-policy';
import { runCodeProgram } from '../code-mode';
import { mountDynamicPlugin } from '../ipc/dynamic-plugin';
import { runInlineWorkflow } from '../ipc/inline-workflow';

let unsafeOld: string | undefined;

describe('安全边界回归', () => {
  beforeEach(() => {
    unsafeOld = process.env.AURAXIS_ALLOW_UNSAFE_CODE;
    delete process.env.AURAXIS_ALLOW_UNSAFE_CODE;
  });
  afterEach(() => {
    if (unsafeOld === undefined) delete process.env.AURAXIS_ALLOW_UNSAFE_CODE;
    else process.env.AURAXIS_ALLOW_UNSAFE_CODE = unsafeOld;
  });

  it('safeProcessEnv 不向子进程泄露密钥，并保留通用环境', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-secret';
    process.env.AURAXIS_SDK_TOKEN = 'sdk-token';
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/test';
    const env = safeProcessEnv({ TERM: 'xterm-256color', DEEPSEEK_API_KEY: 'override' });
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.AURAXIS_SDK_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/test');
    expect(env.TERM).toBe('xterm-256color');
  });

  it('任意代码执行默认失败关闭', async () => {
    expect(unsafeCodeEnabled()).toBe(false);
    const code = await runCodeProgram('return 1', { projectRoot: 'C:/x', requestId: 'r1', mode: 'ask' });
    expect(code.exitCode).toBe(1);
    expect(code.stderr).toContain('默认禁用');
    const plugin = mountDynamicPlugin({
      id: 'p1', name: 'P', tools: [{ name: 'T', description: 'd', handler: '() => ({})' }],
    });
    expect(plugin.ok).toBe(false);
    const workflow = await runInlineWorkflow('return 1', { projectRoot: 'C:/x', requestId: 'r1', log: () => {} });
    expect(workflow.ok).toBe(false);
  });

  it('只读沙箱只放行明确只读命令，解释器与变异命令均拒绝', () => {
    expect(commandMutates('ls -la').mutates).toBe(false);
    expect(commandMutates('git status --short').mutates).toBe(false);
    expect(commandMutates('node -e "console.log(1)"').mutates).toBe(true);
    expect(commandMutates('rm -rf node_modules').mutates).toBe(true);
    expect(enforceSandbox({ sandboxMode: 'read', toolName: 'Bash', input: { command: 'ls' } }).allowed).toBe(true);
    expect(enforceSandbox({ sandboxMode: 'read', toolName: 'Bash', input: { command: 'node -v' } }).allowed).toBe(false);
  });
});
