import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// AG-1 regression: sub-agent recursion depth must actually be threaded through
// the tool context so the `depth > 3` guard in runSubAgent can fire. Before the
// fix, runAgentTool hard-coded `depth: 1` and ToolContext had no depth field, so
// every nested Agent-tool call reset depth to 1 and the guard never triggered.

const ipcDir = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ipcDir, rel), 'utf-8');

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
    const src = read('tool-handlers.ts');
    expect(src).toContain('depth: (ctx.depth ?? 0) + 1');
    expect(src).not.toMatch(/depth:\s*1,/);
  });

  it('ToolContext carries a depth field', () => {
    const src = read('tool-handlers.ts');
    const ctxMatch = src.match(/export interface ToolContext\s*\{[\s\S]*?\n\}/);
    expect(ctxMatch).toBeTruthy();
    expect(ctxMatch![0]).toContain('depth?: number');
  });

  it('agentLoopRun threads depth into the tool execution context', () => {
    const agentSrc = read('agent-loop.ts');
    expect(agentSrc).toContain('depth: config.depth');
    const cfgMatch = agentSrc.match(/export interface AgentLoopConfig\s*\{[\s\S]*?\n\}/);
    expect(cfgMatch![0]).toContain('depth?: number');

    // The unified step engine forwards depth into the shared tool runner.
    const stepSrc = read('step-engine.ts');
    expect(stepSrc).toContain('depth: cfg.depth');
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
    expect(loopCall![0]).toContain('depth,');
  });
});
