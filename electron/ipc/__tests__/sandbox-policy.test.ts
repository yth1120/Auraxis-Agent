import { describe, it, expect } from 'vitest';
import { enforceSandbox, commandMutates, MUTATION_TOOLS } from '../../sandbox-policy';

describe('sandbox-policy — 每调用沙箱强制', () => {
  it('full mode allows everything', () => {
    expect(enforceSandbox({ sandboxMode: 'full', toolName: 'Write', input: { file_path: 'a.ts' } }).allowed).toBe(true);
    expect(enforceSandbox({ sandboxMode: 'full', toolName: 'Bash', input: { command: 'rm -rf /' } }).allowed).toBe(
      true,
    );
  });

  it('read mode denies mutation tools', () => {
    for (const tool of [...MUTATION_TOOLS]) {
      const r = enforceSandbox({ sandboxMode: 'read', toolName: tool, input: {} });
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain('只读沙箱');
    }
    const read = enforceSandbox({ sandboxMode: 'read', toolName: 'Read', input: { file_path: 'a.ts' } });
    expect(read.allowed).toBe(true);
  });

  it('read mode denies obvious bash mutations but allows reads', () => {
    expect(commandMutates('git commit -m x').mutates).toBe(true);
    expect(commandMutates('rm -rf node_modules').mutates).toBe(true);
    expect(commandMutates('cat a.txt > out.txt').mutates).toBe(true);
    expect(commandMutates('npm install').mutates).toBe(true);
    expect(commandMutates('ls -la && cat readme.md').mutates).toBe(false);
    const denied = enforceSandbox({ sandboxMode: 'read', toolName: 'Bash', input: { command: 'rm -rf node_modules' } });
    expect(denied.allowed).toBe(false);
    const allowed = enforceSandbox({ sandboxMode: 'read', toolName: 'Bash', input: { command: 'ls -la' } });
    expect(allowed.allowed).toBe(true);
  });

  it('workspace-write mode allows reads and writes (confinement is path-level)', () => {
    expect(
      enforceSandbox({ sandboxMode: 'workspace-write', toolName: 'Write', input: { file_path: 'a.ts' } }).allowed,
    ).toBe(true);
    expect(
      enforceSandbox({ sandboxMode: 'workspace-write', toolName: 'Bash', input: { command: 'npm test' } }).allowed,
    ).toBe(true);
  });
});
