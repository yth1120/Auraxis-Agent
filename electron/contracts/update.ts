/** update.ts — 自动更新的跨进程契约（主进程状态机 ↔ preload ↔ renderer）。 */

export type UpdateStatus =
  'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  progressPercent?: number;
  error?: string;
}
