import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  redactTelemetryEvent,
  captureSessionTelemetry,
  flushTelemetry,
  resetTelemetryBuffer,
} from '../session-telemetry';

afterEach(() => {
  delete process.env.AURAXIS_TELEMETRY_MODE;
  delete process.env.AURAXIS_TELEMETRY_ENDPOINT;
  resetTelemetryBuffer();
  vi.unstubAllGlobals();
});

describe('session-telemetry', () => {
  it('redacts to a strict allowlist', () => {
    const out = redactTelemetryEvent({
      type: 'tool',
      status: 'done',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      output: { stdout: 'secret' },
      apiKey: 'sk-123',
      text: '对话内容',
    });
    expect(out).toEqual({ type: 'tool', status: 'done', toolName: 'Bash' });
    expect(JSON.stringify(out)).not.toContain('sk-123');
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  // 回归：usage 事件的真实用量曾在导出时被整段 redact（allowlist 只收了
  // tokensBefore/tokensAfter 这类压缩近似值，没有 inputTokens/outputTokens），
  // 导致遥测里的用量数据是个空壳。
  it('keeps real usage counters, and still drops content in the same event', () => {
    const out = redactTelemetryEvent({
      type: 'usage',
      model: 'deepseek-flash',
      inputTokens: 1200,
      outputTokens: 340,
      reasoningTokens: 128,
      cacheHitTokens: 900,
      cacheMissTokens: 300,
      // 同一个事件里夹带的内容字段仍然必须被丢弃。
      text: '对话内容',
      input: { prompt: 'sk-secret' },
    });
    expect(out).toEqual({
      type: 'usage',
      model: 'deepseek-flash',
      inputTokens: 1200,
      outputTokens: 340,
      reasoningTokens: 128,
      cacheHitTokens: 900,
      cacheMissTokens: 300,
    });
    expect(JSON.stringify(out)).not.toContain('对话内容');
    expect(JSON.stringify(out)).not.toContain('sk-secret');
  });

  it('flushes redacted NDJSON to the endpoint in full mode', async () => {
    process.env.AURAXIS_TELEMETRY_MODE = 'full';
    process.env.AURAXIS_TELEMETRY_ENDPOINT = 'https://t.example/ingest';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    captureSessionTelemetry('s1', 'chat', [
      { type: 'assistant_chunk', text: '机密内容', ts: 1 },
      { type: 'tool', toolName: 'Bash', input: { command: 'cat secret' } },
    ]);
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://t.example/ingest');
    const body = String(opts.body);
    expect(body).toContain('assistant_chunk');
    expect(body).toContain('Bash');
    expect(body).not.toContain('机密内容');
    expect(body).not.toContain('secret');
  });

  it('captures nothing in off mode', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    captureSessionTelemetry('s1', 'chat', [{ type: 'user', text: 'x' }]);
    await flushTelemetry(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('feedback-only flushes only on force (user feedback)', async () => {
    process.env.AURAXIS_TELEMETRY_MODE = 'feedback-only';
    process.env.AURAXIS_TELEMETRY_ENDPOINT = 'https://t.example/ingest';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    captureSessionTelemetry('s1', 'chat', [{ type: 'user' }]);
    await flushTelemetry(false);
    expect(fetchMock).not.toHaveBeenCalled();
    await flushTelemetry(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
