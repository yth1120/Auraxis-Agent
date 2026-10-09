/**
 * ActivityDetail.tsx — 展开态的内容区。
 *
 * 分派原则：**专用件优先，用不上才退回通用 IN/OUT**。
 * 提取层不在这里 —— 它只有一份，住在 `core/activity/agentCards.ts`
 * （聊天区 / Agent 会话 / 轨迹时间线三个视图共用），这里只负责调用与兜底样式。
 *
 * 两种"通用面板"的区别是刻意的：Activity 视图要能显示图片结果、要标注 ERR/OUT，
 * 而轨迹时间线是密集表格，用一行 pre 就够 —— 所以 `ToolOutputCard` 的兜底
 * 由调用方以 render prop 传入。
 */
import { memo, useCallback } from 'react';
import clsx from 'clsx';
import { useT } from '../../i18n';
import type { ActivityItem } from '../../types/activity';
import type { PermissionRequest } from '../../types/advanced';
import { detailKindForTool } from '../../core/activity/presentation';
import { activityTool } from '../../core/activity/agentCards';
import { useActivityStore } from '../../stores/useActivityStore';
import { useAdvancedStore } from '../../stores/useAdvancedStore';
import { permissionBridge } from '../../services/replBridge';
import ToolOutputCard from '../agent/ToolOutputCard';
import DiffView from '../permissions/DiffView';
import InlinePermissionCard from '../permissions/InlinePermissionCard';

export interface ActivityDetailProps {
  item: ActivityItem;
  /** 权限项的原始请求对象（由上层注入，见 ActivityItem 的说明）。 */
  permissionRequest?: PermissionRequest;
}

function outputText(item: ActivityItem): string {
  if (item.error) return item.error;
  if (item.output === undefined || item.output === null) return '';
  return typeof item.output === 'string' ? item.output : JSON.stringify(item.output, null, 2);
}

export default memo(function ActivityDetail({ item, permissionRequest }: ActivityDetailProps) {
  const t = useT();
  const kind = detailKindForTool(item.toolName, item.type);
  const input = item.input ?? {};

  // 决策回调必须是稳定引用：卡片的倒计时 effect 依赖 onResolved，每次渲染换新函数会把
  // 计时器重置一遍。所以按 requestId 记忆（hooks 必须在任何 return 之前声明）。
  const requestId = permissionRequest?.requestId;
  const handlePermissionResolved = useCallback(
    (decision: 'granted' | 'denied') => {
      if (!requestId) return;
      // ① Activity 行据此原地从"等待确认"变成"已授权/已拒绝"；② 出队；③ 桥接状态归位。
      useActivityStore.getState().recordApproval(requestId, decision);
      useAdvancedStore.getState().dequeuePermission(requestId);
      if (useAdvancedStore.getState().permissionQueue.length === 0) permissionBridge._setStatus('idle');
    },
    [requestId],
  );

  /**
   * 权限项：正在等待时给真正的审批卡片（与 Agent 会话 / Work 面板同一个件，含 Write/Edit 的
   * diff 复核与 120s 倒计时），已决策或有结果时给一行结论。
   *
   * 刻意排在最前面：权限项的 `toolName` 是**被请求的那个工具**（如 Bash），走通用分派会
   * 渲染成一张终端卡 —— 那是"已经在跑的命令"，与"还没被批准的命令"完全是两回事。
   *
   * **只有 `status === 'waiting'` 才挂卡片**：卡片挂载时会按 `timestamp` 算 120s 倒计时，
   * 对一条早已过期的请求一挂上就写 `denied` —— 重开会话的历史权限行会因此从「已授权」
   * 翻成「已拒绝」。等待以外的状态一律不给可点按钮。
   */
  if (item.type === 'permission') {
    if (item.status === 'waiting' && permissionRequest) {
      return <InlinePermissionCard request={permissionRequest} onResolved={handlePermissionResolved} />;
    }
    const label =
      item.status === 'completed'
        ? t('activity.permission.granted')
        : item.status === 'cancelled'
          ? t('activity.permission.denied')
          : t('activity.permission.stale');
    return (
      <div className="rounded-xl border border-border-default bg-code-bg px-3 py-2 text-2xs text-text-muted">
        {label}
      </div>
    );
  }

  if (kind === 'diff' && item.diff) {
    // 大改动刻意不保留内容（见 MAX_DIFF_CELLS）：如实说明，而不是给一个空 diff。
    if (item.diff.truncated || (item.diff.oldContent === undefined && item.diff.newContent === undefined)) {
      return (
        <div className="rounded-xl border border-border-default bg-code-bg px-3 py-2 text-2xs text-text-muted">
          {t('activity.diff.tooLarge')}
        </div>
      );
    }
    return (
      <DiffView
        oldContent={item.diff.oldContent ?? ''}
        newContent={item.diff.newContent ?? ''}
        fileName={item.diff.path}
      />
    );
  }

  // 通用 IN/OUT 兜底：未登记的工具（MCP / 插件 / 运行时自省）走这里。
  // 作为 render prop 传入 —— 只有确实用不上专用卡片时才付 JSON.stringify 的代价。
  // 图片类结果（ReadImage / BrowserScreenshot）在 ToolOutputCard 里就已渲染成图片。
  const renderFallback = () => {
    const inText = Object.keys(input).length > 0 ? JSON.stringify(input, null, 2).slice(0, 1200) : '';
    const outText = outputText(item).slice(0, 4000);
    if (!inText && !outText) {
      return (
        <div className="rounded-xl border border-border-default bg-code-bg px-3 py-2 text-2xs text-text-muted">
          {t('msg.noOutput')}
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-border-default bg-code-bg overflow-hidden">
        {inText && (
          <div className="grid grid-cols-[max-content_1fr] gap-x-3.5 px-3 py-2 max-h-[150px] overflow-y-auto">
            <span className="sticky top-0 text-2xs font-semibold text-text-faint">IN</span>
            <pre className="m-0 text-2xs leading-relaxed text-text-secondary whitespace-pre-wrap break-all font-mono">
              {inText}
            </pre>
          </div>
        )}
        {inText && outText && <div className="h-px bg-border-dim" />}
        {outText && (
          <div className="grid grid-cols-[max-content_1fr] gap-x-3.5 px-3 py-2 max-h-[240px] overflow-y-auto">
            <span className="sticky top-0 text-2xs font-semibold text-text-faint">{item.error ? 'ERR' : 'OUT'}</span>
            <pre
              className={clsx(
                'm-0 text-2xs leading-relaxed whitespace-pre-wrap break-all font-mono',
                item.error ? 'text-danger' : 'text-text-secondary',
              )}
            >
              {outText}
            </pre>
          </div>
        )}
      </div>
    );
  };

  const { tool, state } = activityTool(item);
  return (
    <ToolOutputCard
      toolName={tool.toolName}
      input={tool.input}
      output={tool.output}
      running={state.running}
      failed={state.failed}
      liveOutput={state.liveOutput}
      error={state.error}
      fallback={renderFallback}
    />
  );
});
