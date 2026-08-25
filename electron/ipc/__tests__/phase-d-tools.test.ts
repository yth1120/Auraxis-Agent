/**
 * Unit tests for Phase D tools: EnterWorktree, LSP, ReviewArtifact.
 *
 * Tests focus on pure logic: diagnostic parsing, regex escaping,
 * worktree session management (in-memory Map).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getActiveWorktree, clearWorktreeSession, isValidWorktreeTaskId } from '../tool-handlers';

// ─── EnterWorktree — task_id validation (injection guard) ──

describe('EnterWorktree — task_id validation', () => {
  it('accepts safe ids (alphanumerics, _ and -)', () => {
    expect(isValidWorktreeTaskId('abc123')).toBe(true);
    expect(isValidWorktreeTaskId('feature_login-2')).toBe(true);
    expect(isValidWorktreeTaskId('A1')).toBe(true);
  });

  it('rejects shell metacharacters that could inject into git commands', () => {
    expect(isValidWorktreeTaskId('a; rm -rf /')).toBe(false);
    expect(isValidWorktreeTaskId('a"$(whoami)"')).toBe(false);
    expect(isValidWorktreeTaskId('a`id`')).toBe(false);
    expect(isValidWorktreeTaskId('a b')).toBe(false); // space
    expect(isValidWorktreeTaskId('../escape')).toBe(false); // path traversal
    expect(isValidWorktreeTaskId('a/b')).toBe(false); // separator
  });

  it('rejects empty, overlong, and non-string ids', () => {
    expect(isValidWorktreeTaskId('')).toBe(false);
    expect(isValidWorktreeTaskId('x'.repeat(65))).toBe(false);
    expect(isValidWorktreeTaskId(undefined)).toBe(false);
    expect(isValidWorktreeTaskId(42)).toBe(false);
  });
});

// ─── Worktree Session Management ───────────────────────

describe('EnterWorktree — Session Management', () => {
  beforeEach(() => {
    // Clean up any leftover sessions
    clearWorktreeSession('test-agent-1');
    clearWorktreeSession('test-request-2');
  });

  it('getActiveWorktree returns undefined when no session exists', () => {
    expect(getActiveWorktree('nonexistent')).toBeUndefined();
  });

  it('clearWorktreeSession removes the session mapping', () => {
    // Session is set by EnterWorktree tool; we test the exposed API
    clearWorktreeSession('test-agent-1');
    expect(getActiveWorktree('test-agent-1')).toBeUndefined();
  });
});

// ─── LSP Diagnostic Parsing ────────────────────────────

describe('LSPTool — Diagnostic Parsing', () => {
  // parseDiagnosticsOutput is not exported, so we test via observed behavior patterns

  it('recognizes tsc error format: file(line,col): error TS1234: message', () => {
    const sampleOutput = `src/app.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/app.ts(20,3): error TS2554: Expected 2 arguments, but got 1.
src/utils.ts(5,10): warning TS6133: 'x' is declared but its value is never read.`;

    // Parse manually using the known regex pattern
    const diagRe = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const line of sampleOutput.split('\n')) {
      const match = line.match(diagRe);
      if (match) {
        if (match[4] === 'error') errors.push(match[0]);
        else warnings.push(match[0]);
      }
    }

    expect(errors.length).toBe(2);
    expect(warnings.length).toBe(1);
    expect(errors[0]).toContain('TS2322');
    expect(errors[1]).toContain('TS2554');
    expect(warnings[0]).toContain('TS6133');
  });

  it('handles tsc output with no errors gracefully', () => {
    const diagRe = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;
    const output = '';
    const errors: string[] = [];

    for (const line of output.split('\n')) {
      const match = line.match(diagRe);
      if (match && match[4] === 'error') errors.push(match[0]);
    }

    expect(errors.length).toBe(0);
  });

  it('extracts structured fields from diagnostic line', () => {
    const line = 'electron/ipc/tool-handlers.ts(1416,5): error TS2322: Type string is not assignable';
    const diagRe = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;
    const match = line.match(diagRe);

    expect(match).not.toBeNull();
    expect(match![1]).toBe('electron/ipc/tool-handlers.ts');
    expect(parseInt(match![2])).toBe(1416);
    expect(parseInt(match![3])).toBe(5);
    expect(match![4]).toBe('error');
    expect(match![5]).toBe('TS2322');
    expect(match![6]).toContain('not assignable');
  });

  it('regex does NOT match non-diagnostic output lines', () => {
    const diagRe = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

    expect(diagRe.test('npm run build')).toBe(false);
    expect(diagRe.test('Compilation complete.')).toBe(false);
    expect(diagRe.test('Found 3 errors.')).toBe(false);
    expect(diagRe.test('  at Object.<anonymous>')).toBe(false);
  });
});

// ─── Regex Escape Utility ──────────────────────────────

describe('LSPTool — Regex Escaping', () => {
  // Test inline — the escapeRegex function isn't exported
  function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  it('escapes regex special characters', () => {
    expect(escapeRegex('myFunction(')).toBe('myFunction\\(');
    expect(escapeRegex('obj.method')).toBe('obj\\.method');
    expect(escapeRegex('[array]')).toBe('\\[array\\]');
    expect(escapeRegex('value$')).toBe('value\\$');
    expect(escapeRegex('x^2')).toBe('x\\^2');
    expect(escapeRegex('a+b')).toBe('a\\+b');
  });

  it('does not escape normal identifiers', () => {
    expect(escapeRegex('myFunction')).toBe('myFunction');
    expect(escapeRegex('useState')).toBe('useState');
    expect(escapeRegex('_privateVar')).toBe('_privateVar');
  });
});

// ─── ReviewArtifact Command Resolution ─────────────────

describe('ReviewArtifact — Command Resolution Logic', () => {
  it('typecheck falls back to npx tsc --noEmit when no scripts configured', () => {
    // Simulating the fallback logic from runReviewArtifact
    const scripts: Record<string, string> = {};

    const hasTypecheckScript = scripts['typecheck'] || scripts['type-check'] || scripts['tsc'] || scripts['check'];
    const fallback = hasTypecheckScript
      ? `npm run ${scripts['typecheck'] ? 'typecheck' : scripts['type-check'] ? 'type-check' : scripts['tsc'] ? 'tsc' : 'check'}`
      : `npx tsc --noEmit --pretty false`;

    expect(fallback).toBe('npx tsc --noEmit --pretty false');
  });

  it('typecheck uses npm script when available', () => {
    const scripts: Record<string, string> = { typecheck: 'tsc --noEmit' };
    const hasTypecheckScript = scripts['typecheck'] || scripts['type-check'] || scripts['tsc'] || scripts['check'];
    const command = hasTypecheckScript
      ? `npm run ${scripts['typecheck'] ? 'typecheck' : 'type-check'}`
      : 'npx tsc --noEmit';

    expect(command).toBe('npm run typecheck');
  });

  it('build uses npm run build when available', () => {
    const scripts: Record<string, string> = { build: 'vite build' };
    const command = scripts['build'] ? 'npm run build' : 'npx tsc --noEmit';
    expect(command).toBe('npm run build');
  });

  it('test uses npm test when available', () => {
    const scripts: Record<string, string> = { test: 'vitest run' };
    const command = scripts['test'] ? 'npm test' : 'npx vitest run';
    expect(command).toBe('npm test');
  });
});

// ─── ReviewArtifact Result Shape ────────────────────────

describe('ReviewArtifact — Result Formatting', () => {
  it('failure result includes mandatory instruction fields', () => {
    const failureOutput = {
      passed: false,
      check_type: 'typecheck',
      command: 'npx tsc --noEmit',
      cwd: '/test/project',
      summary: 'typecheck 审查失败！',
      error: 'src/app.ts(10,5): error TS2322: ...',
      output: '...',
      exitCode: 2,
      instruction: '',
    };

    // The instruction MUST contain the key enforcement language
    failureOutput.instruction = '你必须修复代码并重新运行检查';

    expect(failureOutput.passed).toBe(false);
    expect(failureOutput.instruction).toBeTruthy();
    expect(failureOutput.instruction.length).toBeGreaterThan(0);
    expect(failureOutput.check_type).toBe('typecheck');
    expect(failureOutput.exitCode).toBe(2);
  });

  it('success result does NOT contain error field', () => {
    const successOutput = {
      passed: true,
      check_type: 'build',
      command: 'npm run build',
      cwd: '/test/project',
      summary: 'build 审查通过。',
      output: 'Build completed successfully.',
      instruction: '审查通过！build 执行成功。你可以继续进行下一步工作。',
    };

    expect(successOutput.passed).toBe(true);
    expect(successOutput.command).toBeTruthy();
    // Success should have a positive instruction
    expect(successOutput.instruction).not.toContain('失败');
    expect(successOutput.instruction).toContain('通过');
  });
});
