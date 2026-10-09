/**
 * agent-scheduler-ports.ts — 调度器宿主端口的声明与装配。
 *
 * 调度器核心（`agent-scheduler-class-impl.ts`）只认 `SchedulerHostPorts`，不再直接
 * import electron / PTY / FTS / settings / snapshot —— 这些宿主能力全部收敛在本文件
 * 与 `agent-scheduler-notifier.ts`。无头环境（SDK / CLI / 测试）可经
 * `configureSchedulerHost()` 换掉整张表。
 *
 * 与引擎侧 `agent-runtime/ports.ts` + `ipc/runtime-ports.ts` 同一套写法：核心只依赖
 * 端口声明，宿主实现集中在一个装配点。
 */
import type { AgentSnapshotRecord } from '../agent-snapshot';
import { loadAgentSnapshots, removeAgentSnapshot } from '../agent-snapshot';
import type { AgentTraceRun } from '../contracts/agent-trace';
import { exportAgentTraceOtlp } from '../agent-trace-otlp';
import { ptyRegistry } from './pty-tool';
import { removeFtsDoc } from '../fts';
import { readSettings } from './settings-store';
import { createElectronSchedulerNotifier } from './agent-scheduler-notifier';
import type { SchedulerNotifier } from './agent-scheduler-types';

export interface SchedulerHostPorts {
  /** 向渲染层推送事件的通知端口；没有可用窗口时返回 null。 */
  createNotifier(): SchedulerNotifier | null;
  /** 启动时恢复持久化的 Agent 检查点。 */
  loadSnapshots(): Promise<AgentSnapshotRecord[]>;
  /** 读取设置（恢复快照时用于取回模型密钥）。 */
  readSettings(): Promise<{ deepseekApiKey?: string }>;
  /** Agent 终止后释放其占用的 PTY。 */
  clearPtyOwner(agentId: string): void;
  /** Agent 终止后删除其持久化快照。 */
  removeSnapshot(agentId: string): Promise<void>;
  /** Agent 终止后删除其全文检索文档。 */
  removeSearchDoc(agentId: string): Promise<void>;
  /**
   * 导出一份运行轨迹（OTLP）。默认实现只在设置了 AURAXIS_OTLP_ENDPOINT 时
   * 才有实际动作，且失败不影响运行——遥测属于宿主关注点，核心不直接触达网络。
   */
  exportTrace(run: AgentTraceRun): Promise<void>;
}

/** Electron 宿主的默认实现；桌面与无头 CLI 共用。 */
const electronSchedulerHost: SchedulerHostPorts = {
  createNotifier: () => createElectronSchedulerNotifier(),
  loadSnapshots: () => loadAgentSnapshots(),
  readSettings: async () => (await readSettings()) as { deepseekApiKey?: string },
  clearPtyOwner: (agentId) => ptyRegistry.clearOwner(agentId),
  removeSnapshot: (agentId) => removeAgentSnapshot(agentId),
  removeSearchDoc: (agentId) => removeFtsDoc(agentId),
  exportTrace: (run) => exportAgentTraceOtlp(run),
};

let installed: SchedulerHostPorts = electronSchedulerHost;

/** 换掉调度器的宿主端口（无头环境 / 测试）；不调用即为 Electron 默认实现。 */
export function configureSchedulerHost(ports: SchedulerHostPorts): void {
  installed = ports;
}

/** 复原为 Electron 默认端口（测试收尾用）。 */
export function resetSchedulerHost(): void {
  installed = electronSchedulerHost;
}

/** 取当前装配的调度器宿主端口。 */
export function schedulerHost(): SchedulerHostPorts {
  return installed;
}
