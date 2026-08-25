import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Code as CodeIcon,
  FileText as FileIcon,
  MagnifyingGlass as SearchIcon,
  Globe as GlobeIcon,
  PencilSimple as PencilIcon,
  Wrench as WrenchIcon,
  Clock as ClockIcon,
} from '@/components/common/icons';
import type { PermissionRequest, PermissionRule } from '../../types/advanced';
import { permissionBridge } from '../../services/replBridge';
import { useAdvancedStore } from '../../stores/useAdvancedStore';
import DiffView from './DiffView';
import clsx from 'clsx';
import { useT, type I18nKey } from '../../i18n';

const TOOL_ICONS: Record<string, React.ReactNode> = {
  Bash: <CodeIcon />,
  Read: <FileIcon />,
  Write: <PencilIcon />,
  Edit: <PencilIcon />,
  Grep: <SearchIcon />,
  Glob: <SearchIcon />,
  WebFetch: <GlobeIcon />,
  WebSearch: <GlobeIcon />,
  EnterWorktree: <CodeIcon />,
};

const TOOL_RISK: Record<string, { level: 'low' | 'medium' | 'high'; labelKey: I18nKey }> = {
  Bash: { level: 'high', labelKey: 'perm.risk.bash' },
  Write: { level: 'high', labelKey: 'perm.risk.write' },
  Edit: { level: 'high', labelKey: 'perm.risk.edit' },
  WebFetch: { level: 'medium', labelKey: 'perm.risk.web' },
  WebSearch: { level: 'medium', labelKey: 'perm.risk.web' },
  CronCreate: { level: 'medium', labelKey: 'perm.risk.cron' },
  EnterWorktree: { level: 'medium', labelKey: 'perm.risk.worktree' },
  Agent: { level: 'medium', labelKey: 'perm.risk.agent' },
};

const COLLAPSE_LINES = 3;

/** Tool-aware one-glance summary — replaces the old full-JSON dump. */
function summarize(toolName: string, input: Record<string, unknown>): { primary: string; isCommand: boolean } {
  switch (toolName) {
    case 'Bash':
      return { primary: String(input.command ?? ''), isCommand: true };
    case 'Read':
    case 'Write':
    case 'Edit':
      return { primary: String(input.file_path ?? ''), isCommand: false };
    case 'Grep':
      return { primary: String(input.pattern ?? '') + (input.path ? `  in ${input.path}` : ''), isCommand: false };
    case 'Glob':
      return { primary: String(input.pattern ?? ''), isCommand: false };
    case 'WebFetch':
      return { primary: String(input.url ?? ''), isCommand: false };
    case 'WebSearch':
      return { primary: String(input.query ?? ''), isCommand: false };
    default: {
      const kv = Object.entries(input)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n');
      return { primary: kv, isCommand: false };
    }
  }
}

interface InlinePermissionCardProps {
  request: PermissionRequest;
  onResolved: () => void;
}

export default function InlinePermissionCard({ request, onResolved }: InlinePermissionCardProps) {
  const t = useT();
  const [responding, setResponding] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [expiresIn, setExpiresIn] = useState(120);

  // ── Expiration countdown — backend auto-denies at 120s ──
  useEffect(() => {
    const elapsed = Math.floor((Date.now() - request.timestamp) / 1000);
    const remaining = Math.max(0, 120 - elapsed);
    setExpiresIn(remaining);
    if (remaining === 0) {
      onResolved();
      return;
    }
    const interval = setInterval(() => {
      setExpiresIn((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [request.requestId, request.timestamp, onResolved]);

  useEffect(() => {
    if (expiresIn === 0) onResolved();
  }, [expiresIn, onResolved]);

  const handleRespond = useCallback(
    async (allowed: boolean, scope: 'once' | 'session' | 'always' = 'once') => {
      setResponding(true);
      try {
        if (allowed && scope !== 'once') {
          const rule: PermissionRule = {
            id: `rule-${Date.now()}`,
            toolName: request.toolName,
            action: 'allow',
            scope,
            createdAt: Date.now(),
          };
          await permissionBridge.addRule(rule, request.requestId);
          useAdvancedStore.getState().addPermissionRule(rule);
        }
        await permissionBridge.respond(request.requestId, allowed);
      } catch {
        await window.electronAPI?.permission?.respond(request.requestId, allowed);
      } finally {
        setResponding(false);
        onResolved();
      }
    },
    [request, onResolved],
  );

  const risk = TOOL_RISK[request.toolName];
  const riskLabel = risk ? t(risk.labelKey) : undefined;

  // ── Diff-driven review for Write/Edit ──
  const isModifyTool = request.toolName === 'Write' || request.toolName === 'Edit';
  const diffNewContent = useMemo(() => {
    if (!isModifyTool || request.oldContent === undefined) return undefined;
    if (request.toolName === 'Write') {
      return (request.input.content as string) || '';
    }
    const oldStr = (request.input.old_string as string) || '';
    const newStr = (request.input.new_string as string) || '';
    return (request.oldContent || '').replace(oldStr, newStr);
  }, [request.oldContent, request.input, isModifyTool, request.toolName]);
  const showDiff = isModifyTool && diffNewContent !== undefined;

  const { primary, isCommand } = summarize(request.toolName, request.input);
  const lines = primary.split('\n');
  const collapsible = lines.length > COLLAPSE_LINES;
  const shown = collapsible && !expanded ? lines.slice(0, COLLAPSE_LINES).join('\n') : primary;

  const btnBase =
    'px-3 py-[3px] rounded-md text-xs leading-5 cursor-pointer transition-colors duration-fast ease-out disabled:opacity-50 disabled:cursor-default';

  return (
    <div className="my-2.5 px-3 py-2.5 border border-dim rounded-md bg-warning-soft text-xs">
      {/* ── Head: icon + tool + risk hint + countdown ── */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="inline-flex text-base text-secondary shrink-0">
          {TOOL_ICONS[request.toolName] || <WrenchIcon />}
        </span>
        <span className="font-semibold text-xs text-primary shrink-0">{request.toolName}</span>
        {risk && (
          <span className={clsx('text-2xs text-muted truncate', risk.level === 'high' && 'text-text-muted')}>
            {riskLabel}
          </span>
        )}
        <span
          className={clsx(
            'inline-flex items-center gap-0.5 ml-auto text-2xs text-muted tabular-nums shrink-0',
            expiresIn < 30 && 'text-text-muted',
          )}
        >
          <ClockIcon /> {expiresIn}s
        </span>
      </div>

      {/* ── Body: tool-aware summary ── */}
      {showDiff ? (
        <>
          <div className="mt-2 font-mono text-2xs text-secondary truncate">{String(request.input.file_path ?? '')}</div>
          <div className="mt-1.5 max-h-[220px] overflow-y-auto border border-dim rounded-md">
            <DiffView
              oldContent={request.oldContent!}
              newContent={diffNewContent!}
              fileName={(request.input.file_path as string) || undefined}
              mode="unified"
            />
          </div>
        </>
      ) : (
        primary && (
          <div className="mt-2">
            <pre className="m-0 py-1.5 px-2.5 rounded-md bg-[var(--color-primary-soft)] border border-[var(--color-primary-border)] font-mono text-2xs leading-[1.55] text-[var(--color-text-primary)] whitespace-pre-wrap break-all max-h-45 overflow-y-auto">
              {isCommand ? `$ ${shown}` : shown}
            </pre>
            {collapsible && (
              <button
                type="button"
                className="mt-1 p-0 border-none bg-transparent text-2xs text-muted cursor-pointer hover:text-primary transition-colors duration-fast ease-out"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? t('perm.collapse') : t('perm.expandLines', { n: lines.length })}
              </button>
            )}
          </div>
        )
      )}

      {/* ── Actions ── */}
      <div className="flex justify-end gap-2 mt-2.5">
        <button
          type="button"
          className={`${btnBase} border-none bg-transparent text-muted hover:bg-danger-soft hover:text-text-secondary`}
          disabled={responding}
          onClick={() => handleRespond(false)}
        >
          {t('perm.deny')}
        </button>
        <button
          type="button"
          className={`${btnBase} border border-[var(--color-primary-border)] bg-[var(--color-primary-soft)] text-[var(--color-primary)] hover:bg-[var(--color-primary-strong)]`}
          disabled={responding}
          onClick={() => handleRespond(true, 'once')}
        >
          {t('perm.allowOnce')}
        </button>
        <button
          type="button"
          className={`${btnBase} border border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-text-on-accent)] hover:opacity-[0.88]`}
          disabled={responding}
          onClick={() => handleRespond(true, 'always')}
        >
          {t('perm.always')}
        </button>
      </div>
    </div>
  );
}
