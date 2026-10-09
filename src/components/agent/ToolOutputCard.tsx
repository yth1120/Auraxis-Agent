/**
 * ToolOutputCard.tsx — 工具输出的**唯一**渲染入口（提取层见 `core/activity/agentCards.ts`）。
 *
 * 聊天区（ActivityDetail）、Agent 会话、轨迹时间线三个视图此前各写了一遍
 * Read/Grep/Web/Diff/RunCode 的渲染，本组件把它们收成一条路径。
 *
 * `fallback` 是 render prop 而不是节点：通用面板会对大输出做 `JSON.stringify`
 * （见各调用方），只有在**确实没有专用卡片**时才值得付这个成本。
 */
import { memo } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import {
  agentCardFor,
  imageDataUrl,
  type AgentCard,
  type PtyCardModel,
  type ToolLike,
  type ToolState,
} from '../../core/activity/agentCards';
import { useT } from '../../i18n';
import TerminalBlock from '../common/TerminalBlock';
import {
  AgentDiffCard,
  AgentPlanCard,
  AgentReadCard,
  AgentRunCodeCard,
  AgentSearchCard,
  AgentWebCard,
} from './AgentToolCards';

export interface ToolOutputCardProps extends ToolLike, ToolState {
  /** 没有专用卡片时渲染这个（各调用方密度不同，因此由调用方给）。 */
  fallback: () => ReactNode;
}

/**
 * 常驻终端的一次操作。
 *
 * read 复用 TerminalBlock（它已经解析 ANSI、不软换行、带复制）—— 会话输出本来就是终端文本，
 * 不该以 JSON 的形状给用户看。其余动作是"回执"，一行说清做了什么。
 */
function PtyCard({
  action,
  sessionId,
  command,
  output,
  sessions,
  signal,
  closed,
  closedCount,
  sentChars,
  running,
}: PtyCardModel & { running?: boolean }) {
  const t = useT();
  const where = sessionId ? ` · ${sessionId}` : '';

  if (action === 'read') {
    return <TerminalBlock command={sessionId ?? ''} output={output ?? ''} running={running} />;
  }

  let text: string;
  switch (action) {
    case 'create':
      text = `${t('pty.created')}${command ? ` · ${command}` : ''}${where}`;
      break;
    case 'list':
      text = sessions && sessions.length > 0 ? '' : t('pty.noSessions');
      break;
    case 'write':
      text = `${t('pty.sent', { n: sentChars ?? 0 })}${where}`;
      break;
    case 'signal':
      text = `${t('pty.signaled', { signal: signal ?? '' })}${where}${closed ? ` · ${t('pty.closedSession')}` : ''}`;
      break;
    case 'clear':
      text = t('pty.closedCount', { n: closedCount ?? 0 });
      break;
    default:
      text = `${t('pty.closedSession')}${where}`;
      break;
  }

  return (
    <div className="rounded-xl border border-border-default bg-code-bg px-3 py-2 font-mono text-xs text-text-secondary">
      {text && <div>{text}</div>}
      {action === 'list' && sessions && sessions.length > 0 && (
        <div className={clsx('flex flex-col gap-0.5', text && 'mt-1')}>
          {sessions.map((s) => (
            <div key={s.id} className="min-w-0 truncate">
              <span className="text-text-faint">{s.id}</span> <span className="text-text-secondary">{s.command}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 卡片渲染器注册表。
 *
 * 用**映射类型**声明而不是 `switch`：新增一种卡片却忘了接线，会直接编译失败
 * （`switch` 漏 case 只会静默返回 undefined —— 屏幕上什么都不显示，最难查的那种）。
 * 这里也是唯一一处把联合收窄成具体卡片的 cast，收在注册表调用点上。
 */
type CardRenderers = {
  [K in AgentCard['card']]: (card: Extract<AgentCard, { card: K }>) => ReactNode;
};

const RENDERERS: CardRenderers = {
  pty: (card) => <PtyCard {...card.props} />,
  terminal: (card) => (
    <TerminalBlock
      command={card.props.command}
      cwd={card.props.cwd}
      home={window.electronAPI?.homePath || ''}
      output={card.props.output}
      exitCode={card.props.exitCode}
      running={card.props.running}
      failed={card.props.failed}
    />
  ),
  read: (card) => <AgentReadCard {...card.props} />,
  search: (card) => <AgentSearchCard {...card.props} />,
  web: (card) => <AgentWebCard {...card.props} />,
  code: (card) => <AgentRunCodeCard {...card.props} />,
  diff: (card) => <AgentDiffCard {...card.props} />,
  plan: (card) => <AgentPlanCard {...card.props} />,
};

export default memo(function ToolOutputCard({
  toolName,
  input,
  output,
  running,
  failed,
  liveOutput,
  error,
  fallback,
}: ToolOutputCardProps) {
  const t = useT();
  const image = imageDataUrl(output);
  const state: ToolState = {};
  if (running) state.running = true;
  if (failed) state.failed = true;
  if (liveOutput) state.liveOutput = liveOutput;
  if (error) state.error = error;

  if (image) {
    return (
      <div className="rounded-xl border border-border-default bg-code-bg px-3 py-2">
        <img
          src={image}
          alt={t('toolCard.readImageResult')}
          className="max-w-full max-h-[320px] rounded-md border border-[var(--color-border-dim)] object-contain bg-[var(--color-bg-inset)]"
        />
      </div>
    );
  }

  const card = agentCardFor({ toolName, input, output }, state);
  if (!card) return <>{fallback()}</>;
  const render = RENDERERS[card.card] as (c: AgentCard) => ReactNode;
  return render(card);
});
