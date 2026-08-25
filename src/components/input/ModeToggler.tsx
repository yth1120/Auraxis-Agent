import { forwardRef, memo, useEffect } from 'react';
import { Brain, CaretDown, Check as CheckIcon } from '@/components/common/icons';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { BUILT_IN_MODELS } from '../../types/chat';
import clsx from 'clsx';
import { useT, type I18nKey } from '../../i18n';
import { ThinkingDepthSelector, THINKING_LEVELS, type ThinkingLevel } from './ThinkingDepthSelector';
import type { ReactNode } from 'react';

const THINKING_LABEL_KEY: Record<ThinkingLevel, I18nKey> = {
  low: 'think.low',
  medium: 'think.medium',
  high: 'think.high',
};

const THINKING_DESC_KEY: Record<ThinkingLevel, I18nKey> = {
  low: 'think.low.desc',
  medium: 'think.medium.desc',
  high: 'think.high.desc',
};

function modelName(modelId: string): string {
  return BUILT_IN_MODELS.find((m) => m.id === modelId)?.name ?? modelId;
}

function modelDescriptionKey(modelId: string): I18nKey {
  if (modelId === 'deepseek-v4-flash') return 'model.desc.flash';
  if (modelId === 'deepseek-v4-pro') return 'model.desc.pro';
  return 'model.desc.vision';
}

const ChevronDown = ({ open }: { open?: boolean }) => (
  <CaretDown
    size={12}
    className={clsx('shrink-0 text-text-muted transition-transform duration-200 ease-out', open && 'rotate-180')}
  />
);

const Check = () => (
  <CheckIcon size={16} className="shrink-0 text-text-primary" />
);

/* ── Trigger button (28px 胶囊按钮) ── */

interface ModeTriggerProps {
  onClick: (e: React.MouseEvent) => void;
  open?: boolean;
}

export const ModeTrigger = memo(
  forwardRef<HTMLButtonElement, ModeTriggerProps>(function ModeTrigger({ onClick, open }, ref) {
    const t = useT();
    const selectedModel = useChatStore((s) => s.selectedModel);
    const reasoningEffort = useChatStore((s) => s.reasoningEffort);
    const sidebarMode = useAppStore((s) => s.sidebarMode);
    const effortLabel = THINKING_LEVELS.includes(reasoningEffort)
      ? t(THINKING_LABEL_KEY[reasoningEffort])
      : t('think.medium');
    // Chat 已改为 DeepSeek 风格：只有思考开关、无思考深度，触发器只显示模型名；
    // Work/Code 保留思考深度，触发器始终显示当前档位。
    const showEffort = sidebarMode !== 'chat';

    return (
      <button
        ref={ref}
        className="inline-flex items-center gap-1 h-8 max-w-[220px] pl-2 pr-1 border-none rounded-full bg-transparent text-text-secondary font-body text-sm leading-5 font-medium cursor-pointer whitespace-nowrap transition-colors duration-150 ease-out hover:bg-[var(--color-hover)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
        onClick={onClick}
        type="button"
        aria-label={t('model.switch')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{modelName(selectedModel)}</span>
        {showEffort && (
          <span className="shrink-0 text-text-muted">/ {effortLabel}</span>
        )}
        <ChevronDown open={open} />
      </button>
    );
  }),
);

/* ── Single-pane dropdown panel: all models + thinking depth ── */

export const ModePanelContent = memo(function ModePanelContent({ onSelect }: { onSelect?: () => void }) {
  const t = useT();
  const selectedModel = useChatStore((s) => s.selectedModel);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const reasoningEffort = useChatStore((s) => s.reasoningEffort);
  const setReasoningEffort = useChatStore((s) => s.setReasoningEffort);
  const sidebarMode = useAppStore((s) => s.sidebarMode);

  // Chat 模式 = DeepSeek 风格（思考开关在输入工具栏，面板只选模型）；
  // Work/Code 默认思考开启、深度滑轨始终可用。
  const isChat = sidebarMode === 'chat';

  // Escape closes the whole menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onSelect?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSelect]);

  const optionCls = 'flex items-center gap-2 w-full min-h-[32px] px-2 py-[4px] border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)]';

  const sectionHeader = (icon: ReactNode, label: string) => (
    <div className="flex items-center gap-1.5 px-2 pt-[4px] pb-[3px] text-text-muted">
      {icon && <span className="flex flex-none items-center justify-center">{icon}</span>}
      <span className="text-xs leading-[18px] font-medium">{label}</span>
    </div>
  );

  return (
    <div className="flex flex-col min-h-0">
      {/* ── Model selection (header icon only; model names stay clean) ── */}
      {sectionHeader(<Brain size={14} />, t('model.title'))}
      {BUILT_IN_MODELS.map((m) => {
        const selected = m.id === selectedModel;
        return (
          <button
            key={m.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            className={optionCls}
            onClick={() => {
              setSelectedModel(m.id);
              onSelect?.();
            }}
          >
            <span className="flex-1 min-w-0 flex flex-col">
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-sm leading-5 font-medium text-text-primary">{m.name}</span>
              {m.experimental && <span className="shrink-0 text-[10px] leading-4 px-1.5 rounded-full bg-[var(--color-warning-soft)] text-warning">{t('model.experimental')}</span>}
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-[17px] text-text-muted">{t(modelDescriptionKey(m.id))}</span>
            </span>
            <span className="flex flex-none w-5 items-center justify-center">{selected ? <Check /> : null}</span>
          </button>
        );
      })}

      {!isChat && (
        <ThinkingDepthSelector
          title={t('think.title')}
          value={reasoningEffort}
          labels={{
            low: t('think.low'),
            medium: t('think.medium'),
            high: t('think.high'),
          }}
          ariaLabel={t('think.title')}
          description={t(THINKING_DESC_KEY[reasoningEffort])}
          onChange={setReasoningEffort}
        />
      )}
    </div>
  );
});
