import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '' },
}));
vi.mock('../../agent-runtime/agent-loop', () => ({
  llmClientInvoke: vi.fn(),
}));

import { detectLlmSignals } from '../signal-llm';
import { llmClientInvoke } from '../../agent-runtime/agent-loop';

import { installAgentRuntimePorts } from '../runtime-ports';

// agent-runtime 通过端口注入宿主能力；测试沿用与生产相同的适配层装配。
installAgentRuntimePorts();

const config = { model: 'deepseek-v4-flash', apiKey: 'sk', apiBase: 'https://api.example/v1/chat/completions' };

describe('detectLlmSignals — 可选 LLM 信号（默认关闭）', () => {
  it('无 API Key 时直接返回空', async () => {
    expect(await detectLlmSignals('text', 'ev1', {})).toEqual([]);
    expect(llmClientInvoke).not.toHaveBeenCalled();
  });

  it('解析合法 JSON 数组并归一化', async () => {
    vi.mocked(llmClientInvoke).mockResolvedValueOnce({
      rawText: '[{"type":"version","value":"6.2.1","confidence":0.9},{"type":"unknown","value":"x"}]',
    } as any);
    const signals = await detectLlmSignals('升级 6.2.1', 'ev1', config);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ evidence_id: 'ev1', signal_type: 'version', value: '6.2.1', detector: 'llm' });
  });

  it('解析失败或调用异常时静默返回空', async () => {
    vi.mocked(llmClientInvoke).mockResolvedValueOnce({ rawText: '不是 JSON' } as any);
    expect(await detectLlmSignals('x', 'ev1', config)).toEqual([]);

    vi.mocked(llmClientInvoke).mockRejectedValueOnce(new Error('api down'));
    expect(await detectLlmSignals('x', 'ev1', config)).toEqual([]);
  });
});
