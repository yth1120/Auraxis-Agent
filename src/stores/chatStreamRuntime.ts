/** chatStreamRuntime.ts — shared chat streaming lifecycle state. */
import type { AIStreamSubscription } from '../types/electron-api';

export interface ChatStreamRuntime {
  abortController: AbortController | null;
  ipcSubscription: AIStreamSubscription | null;
  isQueryStream: boolean;
  stopping: boolean;
  streamTimeout: ReturnType<typeof setTimeout> | null;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  lastEventTime: number;
}

export function createChatStreamRuntime(): ChatStreamRuntime {
  return {
    abortController: null,
    ipcSubscription: null,
    isQueryStream: false,
    stopping: false,
    streamTimeout: null,
    heartbeatInterval: null,
    lastEventTime: 0,
  };
}

/** Shared singleton used by the store and stream actions. */
export const chatStreamRuntime = createChatStreamRuntime();

export function clearStreamTimeout(runtime: ChatStreamRuntime): void {
  if (runtime.streamTimeout !== null) {
    clearTimeout(runtime.streamTimeout);
    runtime.streamTimeout = null;
  }
}

export function clearHeartbeatInterval(runtime: ChatStreamRuntime): void {
  if (runtime.heartbeatInterval !== null) {
    clearInterval(runtime.heartbeatInterval);
    runtime.heartbeatInterval = null;
  }
}

export function clearStreamRuntime(runtime: ChatStreamRuntime): void {
  clearStreamTimeout(runtime);
  clearHeartbeatInterval(runtime);
}

export function unsubscribeStream(runtime: ChatStreamRuntime): void {
  runtime.ipcSubscription?.unsubscribe();
  runtime.ipcSubscription = null;
}

export function abortActiveStream(runtime: ChatStreamRuntime): void {
  if (runtime.ipcSubscription) {
    const api = window.electronAPI?.ai;
    if (api && runtime.ipcSubscription.requestId) {
      if (runtime.isQueryStream) api.abortQuery(runtime.ipcSubscription.requestId);
      else api.abortStream(runtime.ipcSubscription.requestId);
    }
    runtime.ipcSubscription.unsubscribe();
    runtime.ipcSubscription = null;
  } else {
    runtime.abortController?.abort();
  }
  runtime.abortController = null;
}
