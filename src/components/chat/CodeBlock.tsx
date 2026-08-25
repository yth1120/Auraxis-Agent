import { errorText } from '../../../electron/errors';
import { useState, useCallback, useEffect, memo } from 'react';
import { message, Modal, Input } from 'antd';
import { useT } from '../../i18n';
import {
  Copy as CopyOutlined,
  Check as CheckOutlined,
  Play as PlayOutlined,
  FilePlus as FilePlusOutlined,
  Eye as EyeOutlined,
} from '@/components/common/icons';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useAgentStore } from '../../stores/useAgentStore';
import { createAgent } from '../../constants/commands';
import { resolveFollowTarget } from '../../utils/followTarget';
import { scrubSandboxPaths } from '../../utils/scrub';
import { mapThinkingLevelToEffort } from '../../types/chat';
import { HighlightedCode } from './CodeBlockHighlight';

interface CodeBlockProps {
  language: string;
  code: string;
  onApply?: (code: string) => void;
  onPreview?: (code: string) => void;
}

function CodeBlock({ language, code, onApply, onPreview }: CodeBlockProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);
  const [applying, setApplying] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [applyModalOpen, setApplyModalOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const projectPath = useSettingsStore((s) => s.projectPath);

  useEffect(() => {
    setApplied(false);
  }, [code]);

  // Listen for postMessage from the sandboxed preview iframe.
  // Without allow-same-origin the iframe's origin is null — we only accept
  // messages from null-origin iframes when the preview modal is open.
  useEffect(() => {
    if (!previewVisible) return;
    const handler = (e: MessageEvent) => {
      // Sandboxed iframe without allow-same-origin has origin null
      if (e.origin !== 'null') return;
      const { type, payload } = e.data || {};
      if (type === 'apply-code' && typeof payload === 'string') {
        setFileName(language);
        setApplyModalOpen(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [previewVisible, language]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      message.success(t('code.copied'));
      setTimeout(() => setCopied(false), 2000);
    } catch (err: unknown) {
      console.debug('[CodeBlock] 复制到剪贴板失败:', errorText(err) || err);
      message.error(t('code.copyFailed'));
    }
  }, [code, t]);

  // 继续写：Chat 走官方前缀续写；Work/Code 走 Agent 任务链路（续接/排队/新建）。
  const handleContinue = useCallback(() => {
    const mode = useAppStore.getState().sidebarMode;
    const instructionText = `请继续写下面的 ${language} 代码，从已有代码的末尾接着实现，不要重复已有内容。\n\n\`\`\`${language}\n${code}\n\`\`\``;
    if (mode === 'chat') {
      if (useChatStore.getState().isStreaming) {
        message.info(t('code.continueBusy'));
        return;
      }
      useChatStore.getState().continueCode(language, code);
      return;
    }

    const agentState = useAgentStore.getState();
    const current = agentState.currentAgentId
      ? (agentState.agents.find((a) => a.id === agentState.currentAgentId) ?? null)
      : null;
    // Agent 正在运行/暂停/排队 → 作为跟进消息入队，任务结束后自动继续。
    if (current && (current.status === 'running' || current.status === 'paused' || current.status === 'queued')) {
      useChatStore.getState().enqueueAgentMessage(instructionText);
      message.info(t('code.continueQueued'));
      return;
    }
    // 有已结束/可续接的任务 → 续接同一任务（保留上下文与工作目录）。
    const follow = resolveFollowTarget({ selected: current, agents: agentState.agents, pendingNewTask: false });
    if (follow) {
      const priorResult = scrubSandboxPaths(follow.result || '（无结果记录）').slice(0, 2000);
      const finalInstruction = `请继续当前任务，在前序工作的基础上推进。\n\n【任务背景】\n${follow.description || follow.name}\n\n【当前进展】\n${priorResult}\n\n【现在请继续】\n${instructionText}\n\n请继续在同一个工作目录内工作，不要访问历史任务的沙箱目录。`;
      void useAgentStore
        .getState()
        .continueAgent(follow.id, finalInstruction, instructionText)
        .then((cont) => {
          if (cont.ok) {
            useAgentStore.getState().setCurrentAgent(follow.id);
          } else {
            message.error(cont.error || t('composer.continueFailed'));
          }
        });
      return;
    }
    // 无任务可续 → 新建一个 Agent 任务。
    const projectPath = useSettingsStore.getState().projectPath || useChatStore.getState().currentProjectPath || '';
    if (!projectPath) {
      message.warning(t('code.noProject'));
      return;
    }
    const chatState = useChatStore.getState();
    void createAgent({
      name: '继续写代码',
      type: 'general-purpose',
      instruction: instructionText,
      displayText: instructionText,
      model: chatState.selectedModel,
      isDeepThink: true,
      reasoningEffort: mapThinkingLevelToEffort(chatState.reasoningEffort),
    }).then((id) => {
      if (id) useAgentStore.getState().setCurrentAgent(id);
    });
  }, [language, code, t]);

  const extMap: Record<string, string> = {
    typescript: '.ts',
    ts: '.ts',
    tsx: '.tsx',
    javascript: '.js',
    js: '.js',
    jsx: '.jsx',
    css: '.css',
    html: '.html',
    json: '.json',
    md: '.md',
    py: '.py',
    rs: '.rs',
    go: '.go',
    java: '.java',
    vue: '.vue',
    svelte: '.svelte',
    scss: '.scss',
    less: '.less',
  };

  const defaultExt = extMap[language.toLowerCase()] || `.${language}`;

  const handleApplyClick = useCallback(() => {
    if (onApply) {
      onApply(code);
      setApplied(true);
      message.success(t('code.applied'));
      return;
    }
    if (!projectPath) {
      message.warning(t('code.noProject'));
      return;
    }
    setFileName(`generated-${Date.now()}${defaultExt}`);
    setApplyModalOpen(true);
  }, [code, onApply, projectPath, defaultExt, t]);

  const handleApplyConfirm = useCallback(async () => {
    const api = window.electronAPI;
    if (api && projectPath) {
      setApplying(true);
      setApplyModalOpen(false);
      try {
        const result = await api.project.applyCode({
          filePath: fileName,
          code,
          projectRoot: projectPath,
        });

        if (result.ok) {
          setApplied(true);
          message.success(
            t('code.appliedAction', {
              action: result.action === 'created' ? t('code.created') : t('code.overwritten'),
              file: fileName,
            }),
          );
        } else {
          message.error(result.error || t('code.applyFailed'));
        }
      } catch (err: unknown) {
        message.error(errorText(err) || t('code.applyFailed'));
      } finally {
        setApplying(false);
      }
    }
  }, [code, fileName, projectPath, t]);

  const handlePreview = useCallback(async () => {
    if (onPreview) {
      onPreview(code);
      return;
    }

    // Try IPC-based preview
    const api = window.electronAPI;
    if (api) {
      const extMap: Record<string, string> = {
        typescript: '.tsx',
        ts: '.tsx',
        tsx: '.tsx',
        javascript: '.jsx',
        js: '.jsx',
        jsx: '.jsx',
        html: '.html',
        css: '.css',
      };
      const ext = extMap[language.toLowerCase()];
      if (!ext) {
        message.warning(t('code.previewUnsupported'));
        return;
      }

      try {
        const result = await api.project.previewCode({
          filePath: `preview${ext}`,
          code,
          projectRoot: '',
        });
        if (result.ok) {
          setPreviewVisible(true);
        } else {
          message.error(result.error || t('code.previewFailed'));
        }
      } catch (err: unknown) {
        message.error(errorText(err) || t('code.previewFailed'));
      }
      return;
    }

    setPreviewVisible(true);
  }, [code, language, onPreview, t]);

  const previewHtml =
    language === 'html'
      ? code
      : `<html><body><pre><code>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre></body></html>`;

  return (
    <div className="my-4 rounded-xl overflow-hidden bg-[var(--color-code-bg)]">
      <div className="flex items-center justify-between px-3 py-1.5 font-mono text-xs text-[var(--color-text-muted)] select-none bg-[var(--color-bg-tertiary)]">
        <span className="font-medium lowercase tracking-wide">{language}</span>
        <span className="inline-flex items-center gap-1">
          <button
            className="inline-flex items-center gap-1 border-none bg-transparent text-[var(--color-text-muted)] text-2xs cursor-pointer px-1.5 py-0.5 rounded-md hover:text-[var(--color-text-secondary)] hover:bg-white/8 transition-colors duration-150"
            onClick={handleContinue}
            type="button"
            title={t('code.continueTip')}
          >
            <PlayOutlined size={12} />
            <span>{t('code.continue')}</span>
          </button>
          <button
            className="inline-flex items-center gap-1 border-none bg-transparent text-[var(--color-text-muted)] text-2xs cursor-pointer px-1.5 py-0.5 rounded-md hover:text-[var(--color-text-secondary)] hover:bg-white/8 transition-colors duration-150 disabled:cursor-wait disabled:opacity-70"
            onClick={handleApplyClick}
            disabled={applying}
            type="button"
            title={t('code.applyTip')}
          >
            {applied ? <CheckOutlined size={12} /> : <FilePlusOutlined size={12} />}
            <span>{applied ? t('code.applied') : t('code.apply')}</span>
          </button>
          <button
            className="inline-flex items-center gap-1 border-none bg-transparent text-[var(--color-text-muted)] text-2xs cursor-pointer px-1.5 py-0.5 rounded-md hover:text-[var(--color-text-secondary)] hover:bg-white/8 transition-colors duration-150"
            onClick={handlePreview}
            type="button"
            title={t('code.preview')}
          >
            <EyeOutlined size={12} />
            <span>{t('code.preview')}</span>
          </button>
          <button
            className="inline-flex items-center gap-1 border-none bg-transparent text-[var(--color-text-muted)] text-2xs cursor-pointer px-1.5 py-0.5 rounded-md hover:text-[var(--color-text-secondary)] hover:bg-white/8 transition-colors duration-150"
            onClick={handleCopy}
            type="button"
          >
            {copied ? <CheckOutlined /> : <CopyOutlined />}
            <span>{copied ? t('code.copiedShort') : t('code.copy')}</span>
          </button>
        </span>
      </div>
      <HighlightedCode language={language} code={code} />

      <Modal
        title={t('code.applyTip')}
        open={applyModalOpen}
        onOk={handleApplyConfirm}
        onCancel={() => setApplyModalOpen(false)}
        okText={t('code.confirmApply')}
        cancelText={t('common.cancel')}
        width={480}
        transitionName=""
        maskTransitionName=""
      >
        <div className="mb-2">
          <label className="text-primary font-body text-sm">{t('code.targetPath')}</label>
        </div>
        <Input
          value={fileName}
          onChange={(e) => setFileName(e.target.value)}
          placeholder="src/components/NewComponent.tsx"
          autoFocus
        />
      </Modal>

      <Modal
        title={t('code.preview')}
        open={previewVisible}
        onCancel={() => setPreviewVisible(false)}
        footer={null}
        width="80%"
        style={{ top: 20 }}
        transitionName=""
        maskTransitionName=""
      >
        <iframe
          srcDoc={previewHtml}
          className="w-full h-[60vh] border-none rounded-md"
          title={t('code.preview')}
          // allow-scripts only — no allow-same-origin.
          // Without allow-same-origin the iframe's origin is null, preventing
          // AI-generated code from accessing the parent window's DOM, cookies,
          // or localStorage. postMessage still works; the listener below
          // validates origin === null for sandboxed iframe communication.
          sandbox="allow-scripts"
        />
      </Modal>
    </div>
  );
}

const CodeBlockMemo = memo(CodeBlock);
export default CodeBlockMemo;
