import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { runHook, runHooksFor, getHooks } from '../../hooks';

let root: string;
let projectRoot: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-hooks-'));
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-hooks-proj-'));
  process.env.AURAXIS_HOOKS_DIR = root;
  process.env.AURAXIS_TRUST_PROJECT_HOOKS = '1';
});

afterEach(async () => {
  delete process.env.AURAXIS_HOOKS_DIR;
  delete process.env.AURAXIS_TRUST_PROJECT_HOOKS;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe('hooks', () => {
  it('runs a command and captures output with exit code', async () => {
    const result = await runHook({ command: 'echo hello-hook' }, {});
    expect(result.ok).toBe(true);
    expect(result.output).toBe('hello-hook');
    expect(result.code).toBe(0);
  });

  it('times out long-running hooks', async () => {
    const result = await runHook({ command: 'node -e "setTimeout(() => {}, 5000)"', timeout: 200 }, {});
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('PreToolUse hook blocks on non-zero exit', async () => {
    await fs.writeFile(
      path.join(root, 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: { command: 'echo blocked && exit 1' } } }),
      'utf8',
    );
    const dispatch = await runHooksFor('PreToolUse', { toolName: 'Bash', input: {} }, projectRoot);
    expect(dispatch.blocked).toBe(true);
    expect(dispatch.outputs.join('')).toContain('blocked');
  });

  it('merges user and project hook layers', async () => {
    await fs.writeFile(
      path.join(root, 'hooks.json'),
      JSON.stringify({ hooks: { Stop: { command: 'echo user-stop' } } }),
      'utf8',
    );
    await fs.mkdir(path.join(projectRoot, '.auraxis'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.auraxis', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: { command: 'echo project-stop' }, SessionStart: { command: 'echo start' } } }),
      'utf8',
    );
    const hooks = await getHooks(projectRoot);
    expect(hooks.Stop?.[0].command).toContain('project-stop');
    expect(hooks.SessionStart).toBeDefined();
  });

  it('project hooks are ignored unless explicitly trusted', async () => {
    delete process.env.AURAXIS_TRUST_PROJECT_HOOKS;
    await fs.mkdir(path.join(projectRoot, '.auraxis'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.auraxis', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: { command: 'echo project-stop' } } }),
      'utf8',
    );
    const hooks = await getHooks(projectRoot);
    expect(hooks.Stop).toBeUndefined();
  });

  it('strips secret-like variables from hook environment', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-secret';
    process.env.AURAXIS_SDK_TOKEN = 'sdk-token';
    process.env.MY_SAFE_VAR = 'visible';
    const probe = path.join(root, 'env-probe.cjs');
    await fs.writeFile(
      probe,
      `console.log(JSON.stringify({ ds: process.env.DEEPSEEK_API_KEY || '', tok: process.env.AURAXIS_SDK_TOKEN || '', safe: process.env.MY_SAFE_VAR || '' }));\n`,
      'utf8',
    );
    try {
      const result = await runHook({ command: `node ${JSON.stringify(probe)}` }, {});
      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.ds).toBe('');
      expect(parsed.tok).toBe('');
      expect(parsed.safe).toBe('visible');
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.AURAXIS_SDK_TOKEN;
      delete process.env.MY_SAFE_VAR;
    }
  });

  it('解析钩子协议响应（stdin JSON + decision envelope）', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'hook-protocol.cjs');
    const result = await runHook({ command: `node ${JSON.stringify(fixture)}` }, { prompt: 'hi' });
    expect(result.protocol?.decision).toBe('allow');
    expect(result.protocol?.continue).toBe(false);
    expect(result.protocol?.stopReason).toBe('用户取消');
    expect(result.protocol?.additionalContext).toContain('hi');
  });

  it('surfaces additionalContext / stopReason and blocks on continue:false', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'hook-protocol.cjs');
    await fs.mkdir(path.join(projectRoot, '.auraxis'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.auraxis', 'hooks.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: { command: `node ${JSON.stringify(fixture)}` } } }),
      'utf8',
    );
    const dispatch = await runHooksFor('UserPromptSubmit', { prompt: 'hi' }, projectRoot);
    expect(dispatch.blocked).toBe(true);
    expect(dispatch.stopReason).toBe('用户取消');
    expect(dispatch.outputs.join('\n')).toContain('来自 hook: hi');
  });
});
