/**
 * hooks.ts — 生命周期钩子（SessionStart / UserPromptSubmit / PreToolUse /
 * PostToolUse / Stop / SessionEnd）。
 *
 * Hooks are external commands invoked at agent lifecycle points. Config is
 * loaded from userData/hooks.json and <project>/.auraxis/hooks.json; both are
 * user/owner-controlled and therefore trusted. A non-zero exit code on
 * PreToolUse blocks the tool call.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';
import { getShellExecutor } from './ipc/shell-executor';

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionEnd';

export interface HookConfig {
  command: string;
  timeout?: number;
}

interface HooksFile {
  hooks?: Partial<Record<HookEvent, HookConfig | HookConfig[]>>;
}

export interface HookRunResult {
  ok: boolean;
  output: string;
  code: number | null;
  timedOut: boolean;
  /** 解析后的钩子协议响应（decision / continue / stopReason / additionalContext）。 */
  protocol?: {
    decision?: 'allow' | 'block';
    continue?: boolean;
    stopReason?: string;
    additionalContext?: string;
  };
}

function userHooksFile(): string {
  if (process.env.AURAXIS_HOOKS_DIR) return path.join(process.env.AURAXIS_HOOKS_DIR, 'hooks.json');
  return path.join(app.getPath('userData'), 'hooks.json');
}

async function readHooksFile(file: string): Promise<Partial<Record<HookEvent, HookConfig[]>> | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as HooksFile;
    if (!parsed.hooks) return {};
    const out: Partial<Record<HookEvent, HookConfig[]>> = {};
    for (const [key, value] of Object.entries(parsed.hooks)) {
      const event = key as HookEvent;
      if (!value) continue;
      out[event] = Array.isArray(value) ? value : [value];
    }
    return out;
  } catch {
    return null;
  }
}

/** Merge user + project hook layers (later layers override same-event hooks). */
export async function getHooks(projectRoot?: string): Promise<Partial<Record<HookEvent, HookConfig[]>>> {
  const merged: Partial<Record<HookEvent, HookConfig[]>> = {};
  const user = await readHooksFile(userHooksFile());
  // 项目目录内的 hooks 默认不执行：打开不受信任仓库可能自动执行任意命令。
  // 只有显式设置 AURAXIS_TRUST_PROJECT_HOOKS=1 才加载项目层 hooks。
  const trustProjectHooks = process.env.AURAXIS_TRUST_PROJECT_HOOKS === '1';
  const project =
    projectRoot && trustProjectHooks ? await readHooksFile(path.join(projectRoot, '.auraxis', 'hooks.json')) : null;
  for (const layer of [user, project]) {
    if (!layer) continue;
    for (const [event, hooks] of Object.entries(layer)) {
      if (hooks) merged[event as HookEvent] = hooks;
    }
  }
  return merged;
}

const HOOK_SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)/i;

/** Hook 进程继承的环境：剥离 API Key / Token 等敏感变量，只留通用环境。 */
function hookEnv(payload: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (HOOK_SECRET_RE.test(k)) continue;
    env[k] = v;
  }
  env.HOOK_PAYLOAD = JSON.stringify(payload);
  return env;
}

export function runHook(config: HookConfig, payload: Record<string, unknown>, cwd?: string): Promise<HookRunResult> {
  return getShellExecutor()
    .run({
      command: config.command,
      shell: true,
      cwd: cwd || process.cwd(),
      env: hookEnv(payload),
      stdin: JSON.stringify(payload),
      timeoutMs: config.timeout ?? 10_000,
    })
    .then((result) => {
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      let protocol: HookRunResult['protocol'];
      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (
          parsed &&
          typeof parsed === 'object' &&
          (parsed.decision !== undefined ||
            parsed.continue !== undefined ||
            parsed.stopReason !== undefined ||
            parsed.additionalContext !== undefined)
        ) {
          protocol = {
            ...(parsed.decision === 'allow' || parsed.decision === 'block' ? { decision: parsed.decision } : {}),
            ...(typeof parsed.continue === 'boolean' ? { continue: parsed.continue } : {}),
            ...(typeof parsed.stopReason === 'string' ? { stopReason: parsed.stopReason } : {}),
            ...(typeof parsed.additionalContext === 'string' ? { additionalContext: parsed.additionalContext } : {}),
          };
        }
      } catch {
        /* plain-text hook output */
      }
      return {
        ok: result.exitCode === 0,
        output,
        code: result.exitCode,
        timedOut: result.timedOut,
        ...(protocol ? { protocol } : {}),
      };
    });
}

export interface HooksDispatch {
  blocked: boolean;
  outputs: string[];
  stopReason?: string;
}

/** Run every hook registered for an event. PreToolUse blocks on non-zero exit. */
export async function runHooksFor(
  event: HookEvent,
  payload: Record<string, unknown>,
  projectRoot?: string,
): Promise<HooksDispatch> {
  const hooks = await getHooks(projectRoot);
  const configs = hooks[event] || [];
  const dispatch: HooksDispatch = { blocked: false, outputs: [] };
  for (const cfg of configs) {
    const result = await runHook(cfg, payload, projectRoot);
    const ctx = result.protocol?.additionalContext;
    if (result.output) dispatch.outputs.push(result.output);
    if (ctx) dispatch.outputs.push(ctx);
    if (!dispatch.stopReason && result.protocol?.stopReason) dispatch.stopReason = result.protocol.stopReason;
    if (event === 'PreToolUse' && (result.protocol?.decision === 'block' || !result.ok)) dispatch.blocked = true;
    if (event === 'UserPromptSubmit' && result.protocol?.continue === false) dispatch.blocked = true;
  }
  return dispatch;
}
