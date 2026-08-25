import { describe, expect, it } from 'vitest';
import { ALLOWED_CONNECT_ORIGINS, buildConnectSrc, buildFrameSrc } from '../../network-policy';

describe('network policy', () => {
  it('keeps production connect-src on an explicit allowlist without wildcards', () => {
    const csp = buildConnectSrc(false);
    expect(csp).not.toContain('https://*');
    expect(csp).not.toContain('http://*');
    expect(ALLOWED_CONNECT_ORIGINS).toContain('https://api.deepseek.com');
  });

  it('adds localhost HMR origins only in development', () => {
    expect(buildConnectSrc(false)).not.toContain('localhost');
    expect(buildConnectSrc(true)).toContain('http://localhost:*');
    expect(buildConnectSrc(true)).toContain('ws://localhost:*');
  });

  it('renders a frame-src that keeps the internal preview usable', () => {
    expect(buildFrameSrc()).toContain('http://127.0.0.1:*');
    expect(buildFrameSrc()).toContain('https:');
  });
});
