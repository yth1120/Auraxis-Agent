/**
 * inline-workflow.ts — model-written orchestration scripts （工作流编排）.
 *
 * The script runs inside a **Node worker thread**（工作线程）so a runaway
 * script can never freeze the host event loop. Inside the
 * worker the script still runs in a `vm` context with an allowlisted global
 * surface (no require / process / fs) plus a `ctx` object:
 *   ctx.projectRoot      — current project root
 *   ctx.log(msg)         — append a line to the workflow transcript
 *   ctx.sleep(ms)        — async delay
 *   ctx.agents.run({description, prompt, subagentType})  — foreground sub-agent
 *   ctx.agents.start({description, prompt, subagentType}) — background sub-agent
 *   ctx.agents.list()    — live agent registry
 *   ctx.agents.send(agentId, message)   — steer a running agent
 *   ctx.agents.interrupt(agentId)       — stop a running agent
 *
 * Scripts are plain JS with top-level `await` inside the async body; end with
 * `return <json-value>` to produce the workflow result.
 */

import { Worker } from 'worker_threads';
import { createOrchestrationApi, type OrchestrationCaller } from './agent-orchestration';
import { unsafeCodeEnabled, unsafeCodeDisabledMessage } from '../safe-env';

export interface InlineWorkflowContext extends OrchestrationCaller {
  log: (line: string) => void;
}

const MAX_SCRIPT_LENGTH = 60_000;
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Static worker body (CJS eval worker). The untrusted script itself arrives
 * via workerData; this source only provides the allowlisted sandbox and the
 * RPC bridge back to the host for ctx.agents.* and ctx.log().
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');

const port = parentPort;
const { script, projectRoot } = workerData;
const pending = new Map();
let nextId = 1;

function callMain(method, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (r) => (r.ok ? resolve(r.result) : reject(new Error(r.error || 'RPC failed'))));
    port.postMessage({ type: 'rpc', id, method, args });
  });
}

port.on('message', (msg) => {
  if (msg && typeof msg.id === 'number' && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

const agents = {
  run: (p) => callMain('run', [p]),
  start: (p) => callMain('start', [p]),
  list: () => callMain('list', []),
  send: (id, message) => callMain('send', [id, message]),
  interrupt: (id) => callMain('interrupt', [id]),
};

const ctx = {
  projectRoot,
  log: (line) => port.postMessage({ type: 'log', line: String(line) }),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0))),
  agents,
};

const sandbox = {
  console: {
    log: (...a) => ctx.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
    warn: (...a) => ctx.log('[warn] ' + a.map(String).join(' ')),
    error: (...a) => ctx.log('[error] ' + a.map(String).join(' ')),
  },
  setTimeout,
  clearTimeout,
  JSON, Math, Date, Object, Array, String, Number, Boolean,
  Promise, Map, Set, Error, RegExp, Symbol, structuredClone,
  ctx,
};

(async () => {
  try {
    const compiled = vm.runInNewContext('(async () => {\\n' + script + '\\n})()', sandbox, { timeout: 30000 });
    if (typeof compiled.then !== 'function') {
      throw new Error('脚本必须是一个 async 函数体（结尾用 return 返回结果）');
    }
    const output = await compiled;
    port.postMessage({ type: 'result', output: output === undefined ? null : output });
  } catch (err) {
    port.postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
})();
`;

export async function runInlineWorkflow(
  script: string,
  ctx: InlineWorkflowContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  if (!unsafeCodeEnabled()) return { ok: false, error: unsafeCodeDisabledMessage('内联工作流') };
  const body = String(script ?? '').trim();
  if (!body) return { ok: false, error: 'script 不能为空' };
  if (body.length > MAX_SCRIPT_LENGTH) {
    return { ok: false, error: `脚本过长（${body.length} 字符，上限 ${MAX_SCRIPT_LENGTH}）` };
  }

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { script: body, projectRoot: ctx.projectRoot },
  });
  const api = createOrchestrationApi(ctx);
  let finished = false;

  const outcome = await new Promise<{ ok: boolean; output?: unknown; error?: string }>((resolve) => {
    const settle = (value: { ok: boolean; output?: unknown; error?: string }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ctx.abortSignal?.removeEventListener('abort', onAbort);
      void worker.terminate().catch(() => {});
      resolve(value);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, error: `工作流脚本执行超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    const onAbort = () => settle({ ok: false, error: '工作流脚本被取消' });
    ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (msg: any) => {
      if (msg?.type === 'rpc') {
        const fn = (api as Record<string, unknown>)[msg.method];
        if (typeof fn !== 'function') {
          worker.postMessage({ id: msg.id, ok: false, error: `未知工作流方法: ${msg.method}` });
          return;
        }
        Promise.resolve((fn as (...args: unknown[]) => unknown)(...(msg.args || [])))
          .then((value) => worker.postMessage({ id: msg.id, ok: true, result: value }))
          .catch((e: any) => worker.postMessage({ id: msg.id, ok: false, error: e?.message || String(e) }));
        return;
      }
      if (msg?.type === 'log') {
        ctx.log(String(msg.line));
        return;
      }
      if (msg?.type === 'result') settle({ ok: true, output: msg.output });
      if (msg?.type === 'error') settle({ ok: false, error: `工作流脚本执行失败: ${msg.error}` });
    });

    worker.on('error', (err) => settle({ ok: false, error: `工作流 worker 错误: ${err.message}` }));
    worker.on('exit', (code) => {
      if (!finished && code !== 0) settle({ ok: false, error: `工作流 worker 异常退出（code=${code}）` });
    });
  });

  return outcome;
}
