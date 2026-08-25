/**
 * code-mode.ts — TypeScript tool-orchestration programs （工具编排程序）.
 *
 * The model submits the BODY of an async TypeScript function. It runs in a
 * worker thread; every `await tools.ToolName(args)` is a submission-ordered
 * sub-call that re-enters the complete guarded tool pipeline (permission
 * profile, sandbox gate, approval, execution) with the same authority as the
 * calling turn. Concurrency-safe tools overlap up to `MAX_PARALLEL_SUB_CALLS`;
 * mutation tools serialize. Only what the program prints or returns goes
 * back to the model.
 */
import { errorText } from './errors';
import { Worker } from 'worker_threads';
import ts from 'typescript';
import type { ApprovalPolicy } from './types';
import type { SandboxMode } from './sandbox-policy';
import { isToolConcurrencySafe } from './tool-registry';
import { executeToolCall } from './ipc/tool-handlers';
import { unsafeCodeEnabled, unsafeCodeDisabledMessage } from './safe-env';

export interface CodeModeHost {
  projectRoot: string;
  requestId: string;
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  autoApprove?: boolean;
  abortSignal?: AbortSignal;
  mode: ApprovalPolicy;
  approvedPlanSteps?: string[];
  depth?: number;
  sandboxMode?: SandboxMode;
  agentId?: string;
  sessionId?: string;
}

export interface CodeModeSubCall {
  id: number;
  name: string;
  input: Record<string, unknown>;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  output?: unknown;
  error?: string;
}

export interface CodeModeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  subCalls: CodeModeSubCall[];
}

const MAX_PARALLEL_SUB_CALLS = 8;
const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_OUTPUT_CAP = 50_000;

function transpileProgram(source: string): string {
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      erasableSyntaxOnly: true,
      strict: true,
    },
    reportDiagnostics: true,
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const detail = errors
      .slice(0, 5)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('; ');
    throw new Error(`TypeScript 语法错误: ${detail}`);
  }
  return out.outputText;
}

function workerSource(transpiled: string): string {
  const body = JSON.stringify(transpiled);
  return `
const { parentPort } = require('worker_threads');
let seq = 0;
const pending = new Map();
const send = (m) => parentPort.postMessage(m);
function call(name, input) {
  return new Promise((resolve, reject) => {
    const id = seq++;
    pending.set(id, { resolve, reject });
    send({ k: 'call', id, name, input });
  });
}
const tools = new Proxy({}, {
  get(_t, prop) {
    const name = String(prop);
    if (name === 'then') return undefined;
    return (input) => call(name, (input && typeof input === 'object') ? input : {});
  },
});
function format(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
const print = (...args) => send({ k: 'log', line: args.map(format).join(' ') + '\\n' });
const console = { log: print, error: print, warn: print, info: print };
parentPort.on('message', (m) => {
  if (!m || m.k !== 'res') return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.reject(new Error(m.error)); else p.resolve(m.output);
});
(async () => {
  try {
    try {
      const runtimeGlobal = globalThis as typeof globalThis & { require?: unknown; process?: unknown; Buffer?: unknown };
      runtimeGlobal.require = undefined;
      runtimeGlobal.process = undefined;
      runtimeGlobal.Buffer = undefined;
    } catch { /* best-effort */ }
    const fn = new Function('tools', 'console', '"use strict"; return (async () => {\\n' + ${body} + '\\n})();');
    const result = await fn(tools, console);
    const text = result === undefined ? '' : (typeof result === 'string' ? result : format(result));
    send({ k: 'done', value: text });
  } catch (e) {
    send({ k: 'error', error: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 1200) });
  }
})();
`;
}

export async function runCodeProgram(
  code: string,
  host: CodeModeHost,
  opts: {
    timeoutMs?: number;
    outputCap?: number;
    /** Test seam — defaults to the real guarded tool dispatcher. */
    executeTool?: (
      name: string,
      input: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Promise<{ output: unknown; error?: string }>;
  } = {},
): Promise<CodeModeResult> {
  if (!unsafeCodeEnabled()) {
    return {
      stdout: '',
      stderr: unsafeCodeDisabledMessage('Code Mode'),
      exitCode: 1,
      timedOut: false,
      aborted: false,
      truncated: false,
      subCalls: [],
    };
  }
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT;
  const outputCap = opts.outputCap && opts.outputCap > 0 ? opts.outputCap : DEFAULT_OUTPUT_CAP;
  const exec = opts.executeTool ?? (executeToolCall as unknown as NonNullable<typeof opts.executeTool>);
  const transpiled = transpileProgram(code);
  const worker = new Worker(workerSource(transpiled), { eval: true });

  const subCalls: CodeModeSubCall[] = [];
  let stdout = '';
  let stderr = '';
  let truncated = false;
  let timedOut = false;
  let aborted = false;
  let exitCode: number | null = 0;

  const appendStdout = (text: string) => {
    if (stdout.length >= outputCap) {
      truncated = true;
      return;
    }
    const remaining = outputCap - stdout.length;
    stdout += text.slice(0, remaining);
    if (text.length > remaining) truncated = true;
  };

  const queue: Array<{ id: number; name: string; input: Record<string, unknown> }> = [];
  let active = 0;
  let unsafeActive = 0;

  const runSubCall = async (item: { id: number; name: string; input: Record<string, unknown> }) => {
    const safe = isToolConcurrencySafe(item.name);
    const entry: CodeModeSubCall = {
      id: item.id,
      name: item.name,
      input: item.input,
      startedAt: Date.now(),
    };
    subCalls.push(entry);
    if (host.abortSignal?.aborted) {
      entry.error = '程序已中止';
      entry.finishedAt = Date.now();
      entry.durationMs = 0;
      worker.postMessage({ k: 'res', id: item.id, output: null, error: entry.error });
      return;
    }
    try {
      const result = await exec(item.name, item.input, {
        projectRoot: host.projectRoot,
        requestId: host.requestId,
        checkPermission: host.checkPermission,
        autoApprove: host.autoApprove,
        abortSignal: host.abortSignal,
        mode: host.mode,
        approvedPlanSteps: host.approvedPlanSteps,
        depth: (host.depth ?? 0) + 1,
        sandboxMode: host.sandboxMode,
        agentId: host.agentId,
        sessionId: host.sessionId,
        toolCallId: `code-${host.requestId}-${item.id}`,
      });
      entry.output = result.output;
      entry.error = result.error;
      worker.postMessage({ k: 'res', id: item.id, output: result.output, error: result.error });
    } catch (err: unknown) {
      entry.error = `子调用异常: ${errorText(err)}`;
      worker.postMessage({ k: 'res', id: item.id, output: null, error: entry.error });
    } finally {
      entry.finishedAt = Date.now();
      entry.durationMs = entry.finishedAt - entry.startedAt;
      active -= 1;
      if (!safe) unsafeActive -= 1;
      pump();
    }
  };

  const pump = () => {
    while (queue.length > 0 && active < MAX_PARALLEL_SUB_CALLS) {
      const next = queue[0];
      const safe = isToolConcurrencySafe(next.name);
      if (!safe && unsafeActive > 0) break;
      queue.shift();
      active += 1;
      if (!safe) unsafeActive += 1;
      void runSubCall(next);
    }
  };

  return new Promise<CodeModeResult>((resolve) => {
    let settled = false;
    const finish = (patch: Partial<CodeModeResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (host.abortSignal) host.abortSignal.removeEventListener('abort', onAbort);
      try {
        void worker.terminate();
      } catch {
        /* gone */
      }
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        aborted,
        truncated,
        subCalls,
        ...patch,
      });
    };

    const onAbort = () => {
      aborted = true;
      finish({ aborted: true, exitCode: null });
    };
    if (host.abortSignal) host.abortSignal.addEventListener('abort', onAbort);

    const timer = setTimeout(() => {
      timedOut = true;
      finish({
        timedOut: true,
        exitCode: null,
        stderr: stderr ? `${stderr}\n程序超时，已强制终止` : '程序超时，已强制终止',
      });
    }, timeoutMs);

    worker.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const m = message as Record<string, unknown>;
      if (m.k === 'log') appendStdout(String(m.line ?? ''));
      else if (m.k === 'call' && typeof m.id === 'number' && Number.isInteger(m.id) && typeof m.name === 'string') {
        const input =
          m.input && typeof m.input === 'object' && !Array.isArray(m.input) ? (m.input as Record<string, unknown>) : {};
        queue.push({ id: m.id, name: m.name, input });
        pump();
      } else if (m.k === 'done') {
        if (typeof m.value === 'string' && m.value) appendStdout(m.value);
        exitCode = 0;
        finish({});
      } else if (m.k === 'error') {
        stderr = `程序异常: ${String(m.error ?? '未知错误')}`;
        if (typeof m.stack === 'string' && m.stack) stderr += `\n${m.stack}`;
        exitCode = 1;
        finish({});
      }
    });

    worker.on('error', (err) => {
      stderr = `Worker 错误: ${err.message}`;
      exitCode = 1;
      finish({});
    });

    worker.on('exit', (code) => {
      if (settled) return;
      if (code !== 0) {
        exitCode = code;
        if (!stderr) stderr = `程序异常退出（代码 ${code}）`;
        finish({});
      }
    });
  });
}
