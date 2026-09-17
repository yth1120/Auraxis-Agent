import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { installAgentRuntimePorts } from '../runtime-ports';

// agent-runtime 通过端口注入宿主能力；测试沿用与生产相同的适配层装配。
installAgentRuntimePorts();

// AG-1 regression: sub-agent recursion depth must actually be threaded through
// the tool context so the `depth > 3` guard in runSubAgent can fire. Before the
// fix, runAgentTool hard-coded `depth: 1` and ToolContext had no depth field, so
// every nested Agent-tool call reset depth to 1 and the guard never triggered.

const ipcDir = path.join(__dirname, '..');
const runtimeDir = path.join(__dirname, '..', '..', 'agent-runtime');
/** 引擎文件已迁到 electron/agent-runtime/，宿主文件仍在 electron/ipc/。 */
const read = (rel: string) => {
  const runtimePath = path.join(runtimeDir, rel);
  const hostPath = path.join(ipcDir, rel);
  return fs.readFileSync(fs.existsSync(runtimePath) ? runtimePath : hostPath, 'utf-8');
};

describe('sub-agent recursion depth — counting logic', () => {
  // Mirror of the two pieces of logic the fix relies on.
  const nextDepth = (d?: number) => (d ?? 0) + 1; // runAgentTool: (ctx.depth ?? 0) + 1
  const overLimit = (d: number) => d > 3; // runSubAgent guard

  it('increments one level per nested Agent call', () => {
    expect(nextDepth(undefined)).toBe(1); // top-level chat → first sub-agent
    expect(nextDepth(1)).toBe(2);
    expect(nextDepth(2)).toBe(3);
    expect(nextDepth(3)).toBe(4);
  });

  it('rejects the 4th nested level, allows the first three', () => {
    expect(overLimit(1)).toBe(false);
    expect(overLimit(2)).toBe(false);
    expect(overLimit(3)).toBe(false);
    expect(overLimit(4)).toBe(true);
  });
});

describe('sub-agent recursion depth — wiring is in place', () => {
  it('runAgentTool no longer hard-codes depth: 1', () => {
    const src = read('tool-handlers/internal.ts');
    expect(src).toContain('depth: (ctx.depth ?? 0) + 1');
    expect(src).not.toMatch(/depth:\s*1,/);
  });

  it('ToolContext carries a depth field', () => {
    const src = read('tool-handlers/path-utils.ts');
    const ctxMatch = src.match(/export interface ToolContext\s*\{[\s\S]*?\n\}/);
    expect(ctxMatch).toBeTruthy();
    expect(ctxMatch![0]).toContain('depth?: number');
  });

  it('agentLoopRun threads depth into the tool execution context', () => {
    const agentSrc = read('agent-loop-types.ts');
    // 循环驱动器拆到 agent-loop-driver.ts（P2）：depth 透传断言随之迁移。
    const runSrc = read('agent-loop-driver.ts');
    expect(runSrc).toContain('depth: config.depth');
    const cfgMatch = agentSrc.match(/export interface AgentLoopConfig\s*\{[\s\S]*?\n\}/);
    expect(cfgMatch![0]).toContain('depth?: number');

    // The unified step engine forwards depth into the shared tool runner.
    // StepEngineConfig lives in the leaf contracts module (step-engine.ts re-exports it).
    const stepSrc = read('step-engine-contracts.ts');
    const toolSrc = read('step-engine-tools.ts');
    expect(toolSrc).toContain('depth: cfg.depth');
    const stepCfgMatch = stepSrc.match(/export interface StepEngineConfig\s*\{[\s\S]*?\n\}/);
    expect(stepCfgMatch![0]).toContain('depth?: number');

    const runnerSrc = read('tool-runner.ts');
    expect(runnerSrc).toContain('depth: ctx.depth');
  });

  it('runSubAgent guards depth and forwards it to its own loop', () => {
    const src = read('agent-handlers.ts');
    expect(src).toContain('const depth = params.depth ?? 0');
    expect(src).toContain('depth > 3');
    // The guard must come before the LLM/settings work so an over-limit call
    // returns immediately without spawning anything.
    const guardIdx = src.indexOf('depth > 3');
    const importIdx = src.indexOf("await import('./settings-store')");
    expect(guardIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(importIdx);
    // depth is passed into the nested agentLoopRun call.
    const loopCall = src.match(/agentLoopRun\(\{[\s\S]*?\n {4}\}\)/);
    expect(loopCall![0]).toContain('depth: cfg.depth');
  });
});
