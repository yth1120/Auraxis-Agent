import { describe, it, expect } from 'vitest';
import {
  isPathWhitelisted,
  isPathInsideRoot,
  scanForRisks,
  validatePlugin,
  loadPlugin,
  getCapabilitySummary,
} from '../plugin-loader';
import type { Plugin } from '../../types/plugin';

// ─── Strict mode: trusted roots supplied ───────────────

describe('isPathWhitelisted — strict mode (allowedRoots)', () => {
  const roots = ['/home/user/proj/plugins'];

  it('allows a file directly inside a trusted root', () => {
    expect(isPathWhitelisted('/home/user/proj/plugins/my-plugin.js', roots)).toBe(true);
    expect(isPathWhitelisted('/home/user/proj/plugins/nested/index.js', roots)).toBe(true);
  });

  it('rejects an out-of-tree path that merely contains a "plugins" segment', () => {
    // The core bug: `/tmp/evil/plugins/x.js` used to pass the substring check.
    expect(isPathWhitelisted('/tmp/evil/plugins/evil.js', roots)).toBe(false);
  });

  it('rejects a sibling directory whose name only shares the "plugins" substring', () => {
    expect(isPathWhitelisted('/home/user/proj/plugins-evil/x.js', roots)).toBe(false);
  });

  it('rejects path traversal that escapes the trusted root', () => {
    expect(isPathWhitelisted('/home/user/proj/plugins/../../../etc/passwd', roots)).toBe(false);
  });

  it('normalises mixed separators and redundant segments', () => {
    expect(isPathWhitelisted('C:\\proj\\plugins\\p.js', ['C:/proj/plugins'])).toBe(true);
    expect(isPathWhitelisted('/home/user/proj/./plugins/p.js', roots)).toBe(true);
  });

  it('rejects everything when no root matches', () => {
    expect(isPathWhitelisted('/var/data/plugins/p.js', roots)).toBe(false);
  });
});

// ─── isPathInsideRoot (segment-aware) ──────────────────

describe('isPathInsideRoot', () => {
  it('treats the root itself as inside', () => {
    expect(isPathInsideRoot('/a/b', '/a/b')).toBe(true);
  });
  it('matches descendants', () => {
    expect(isPathInsideRoot('/a/b/c/d.js', '/a/b')).toBe(true);
  });
  it('does not match substring-only siblings', () => {
    expect(isPathInsideRoot('/a/b-evil/c.js', '/a/b')).toBe(false);
  });
  it('rejects traversal in either argument', () => {
    expect(isPathInsideRoot('/a/b/../../etc', '/a/b')).toBe(false);
  });
  it('rejects an empty root', () => {
    expect(isPathInsideRoot('/a/b', '')).toBe(false);
  });
});

// ─── Fallback mode: no trusted roots ───────────────────

describe('isPathWhitelisted — fallback mode (no roots)', () => {
  it('accepts a real "plugins" path segment with a file beneath it', () => {
    expect(isPathWhitelisted('userData/plugins/p/index.js')).toBe(true);
    expect(isPathWhitelisted('/app/plugins/p.js')).toBe(true);
  });

  it('rejects a substring-only match (myplugins)', () => {
    expect(isPathWhitelisted('/a/myplugins/p.js')).toBe(false);
  });

  it('rejects path traversal even in fallback', () => {
    expect(isPathWhitelisted('../../evil/plugins/p.js')).toBe(false);
  });

  it('rejects a bare plugins dir with nothing beneath it', () => {
    expect(isPathWhitelisted('/app/plugins')).toBe(false);
  });
});

// ─── scanForRisks (regression for existing behaviour) ──

describe('scanForRisks', () => {
  it('flags eval and child_process', () => {
    const risks = scanForRisks(`eval("x"); const cp = require('child_process');`);
    expect(risks.length).toBeGreaterThanOrEqual(2);
  });

  it('returns nothing for benign source', () => {
    expect(scanForRisks(`export default { id: 'x', name: 'x' };`)).toEqual([]);
  });

  it('flags network, fs, and path access patterns', () => {
    const risks = scanForRisks(`fetch('https://evil.example'); require('fs'); require('path');`);
    expect(risks).toContain('fetch() 到非本地地址 — 可发送网络请求');
    expect(risks).toContain('fs — 可读写任意文件');
    expect(risks).toContain('path — 可操作文件路径');
  });
});

describe('validatePlugin', () => {
  it('rejects non-objects and missing required fields', () => {
    expect(validatePlugin(null).valid).toBe(false);
    expect(validatePlugin({ id: 'x' }).warnings.join(' ')).toContain('缺少必填字段');
  });

  it('reports malformed tools while accepting a well-formed plugin', () => {
    expect(
      validatePlugin({ id: 'x', name: 'x', version: '1', description: 'x', tools: [{ name: 't' }] }).warnings.join(' '),
    ).toContain('缺少必填字段');
    expect(validatePlugin({ id: 'x', name: 'x', version: '1', description: 'x' }).valid).toBe(true);
  });
});

describe('loadPlugin and capability summary', () => {
  it('rejects a path outside the plugin whitelist without importing', async () => {
    await expect(loadPlugin('../outside.js')).resolves.toBeNull();
  });

  it('summarizes capabilities and handles an empty plugin', () => {
    const withTool: Plugin = {
      id: 'x',
      name: 'x',
      version: '1',
      description: 'x',
      tools: [{ name: 't', description: 'd', input_schema: { type: 'object', properties: {}, required: [] } }],
    };
    expect(getCapabilitySummary(withTool)).toContain('1 个工具');
    expect(getCapabilitySummary({ id: 'x', name: 'x', version: '1', description: 'x' })).toBe('此插件无扩展点');
  });
});
