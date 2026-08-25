import { useMemo } from 'react';
import { Popover } from 'antd';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { BUILT_IN_MODELS, getContentText } from '@/types/chat';
import { useChatStore } from '@/stores/useChatStore';
import { useAgentStore } from '@/stores/useAgentStore';

const SYSTEM_OVERHEAD_TOKENS = 900;
/** Real context window (DeepSeek V4 = 1M), not the per-model OUTPUT max. */

/** Rough CJK/ASCII mix heuristic — 该仪表为近似估算. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3);
}

/**
 * Context meter （上下文仪表）: a 14px ring at the composer tail.
 * Click to inspect ~used/capacity and the heuristic breakdown.
 */
export default function ContextMeter() {
  const t = useT();
  const messages = useChatStore((s) => s.messages);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const currentAgent = useAgentStore((s) => s.agents.find((a) => a.id === currentAgentId));
  const exactInputTokens = useChatStore((s) => s.exactInputTokens);
  const exactOutputTokens = useChatStore((s) => s.exactOutputTokens);
  const reasoningTokens = useChatStore((s) => s.reasoningOutputTokens);

  const capacity = useMemo(
    () => BUILT_IN_MODELS.find((m) => m.id === selectedModel)?.contextWindow ?? 1_000_000,
    [selectedModel],
  );

  const estimated = useMemo(() => {
    let messageChars = 0;
    let toolChars = 0;
    if (currentAgentId && currentAgent) {
      messageChars += (currentAgent.description || '').length;
      for (const e of currentAgent.log) {
        if (e.type === 'text' || e.type === 'thinking') messageChars += (e.text || '').length;
        if (e.type === 'tool_start' || e.type === 'tool_end' || e.type === 'tool_error') {
          toolChars += JSON.stringify(e.input || {}).length;
          toolChars += JSON.stringify(e.output ?? e.error ?? '').length;
        }
      }
    } else {
      for (const m of messages) {
        messageChars += getContentText(m.content).length;
        for (const tc of m.toolCalls ?? []) toolChars += JSON.stringify(tc.input).length;
      }
    }
    return {
      used: estimateTokens(messageChars + toolChars) + SYSTEM_OVERHEAD_TOKENS,
      msgTokens: estimateTokens(messageChars),
      toolTokens: estimateTokens(toolChars),
    };
  }, [messages, currentAgent, currentAgentId]);

  // Real API-reported usage when the backend has streamed it; the heuristic
  // only previews the context before the first request goes out.
  const real = currentAgentId
    ? {
        input: currentAgent?.totalInputTokens ?? 0,
        output: currentAgent?.totalOutputTokens ?? 0,
        reasoning: 0,
      }
    : { input: exactInputTokens, output: exactOutputTokens, reasoning: reasoningTokens };
  const hasReal = real.input > 0 || real.output > 0;
  const used = hasReal ? real.input : estimated.used;

  const pct = Math.min(100, Math.round((used / capacity) * 100));
  const ringR = 6.5;
  const circumference = 2 * Math.PI * ringR;

  const rows = hasReal
    ? [
        { label: t('ctxMeter.inputReal'), value: real.input, color: 'var(--color-primary)' },
        { label: t('ctxMeter.outputReal'), value: real.output, color: 'var(--color-text-secondary)' },
        { label: t('ctxMeter.reasoningReal'), value: real.reasoning, color: 'var(--color-text-muted)' },
      ]
    : [
        { label: t('ctxMeter.system'), value: SYSTEM_OVERHEAD_TOKENS, color: 'var(--color-primary)' },
        { label: t('ctxMeter.messages'), value: estimated.msgTokens, color: 'var(--color-text-secondary)' },
        { label: t('ctxMeter.tools'), value: estimated.toolTokens, color: 'var(--color-text-muted)' },
      ];

  const content = (
    <div className="w-[240px] flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-text-primary">{t('ctxMeter.title')}</span>
        <span className="text-xs text-text-muted tabular-nums">
          {hasReal ? '' : '~'}
          {used.toLocaleString()} / {capacity.toLocaleString()} tokens
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.label}>
            <div className="flex justify-between text-xs text-text-muted mb-0.5">
              <span>{row.label}</span>
              <span className="tabular-nums">~{row.value.toLocaleString()}</span>
            </div>
            <div className="h-1 rounded-full bg-[var(--color-bg-inset)] overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, (row.value / capacity) * 100)}%`,
                  background: row.color,
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="m-0 text-2xs text-text-faint leading-[1.5]">
        {hasReal ? t('ctxMeter.hintReal') : t('ctxMeter.hint')}
      </p>
    </div>
  );

  return (
    <Popover content={content} trigger="click" placement="topRight">
      <button
        type="button"
        className={clsx('ax-icon-button', pct >= 85 && '!text-warning')}
        aria-label={t('ctxMeter.aria', { pct })}
        title={t('ctxMeter.aria', { pct })}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" className="block">
          <circle cx="8" cy="8" r={ringR} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <circle
            cx="8"
            cy="8"
            r={ringR}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - pct / 100)}
            transform="rotate(-90 8 8)"
          />
        </svg>
      </button>
    </Popover>
  );
}
