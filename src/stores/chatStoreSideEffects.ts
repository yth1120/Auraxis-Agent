/**
 * chatStoreSideEffects.ts — cross-store side effects for the chat store.
 *
 * Mode/plan coupling, pending-task re-arm, and session auto-save subscriptions
 * are registered once and cleaned up together so the store module does not
 * need to own unrelated application wiring.
 */
import type { ChatStore } from '../types/chat';
import { useAppStore } from './useAppStore';
import { useSessionStore, isSessionDeleted } from './useSessionStore';
import { useSettingsStore } from './useSettingsStore';

interface ChatStoreApi {
  getState: () => ChatStore;
  setState: (patch: Partial<ChatStore>) => void;
  subscribe: (listener: (state: ChatStore, prevState: ChatStore) => void) => () => void;
}

let unsubscribers: Array<() => void> = [];
let registered = false;

export function registerChatStoreSideEffects(store: ChatStoreApi): void {
  if (registered) return;
  registered = true;

  // Mode ⇄ plan-mode coupling + per-mode thinking snapshots:
  // - Switching to chat cancels an armed /plan (plan mode belongs to the agent
  //   surfaces and must not leak back after a mode round-trip).
  // - Switching to Work arms plan mode (plan-driven by default); leaving Work
  //   for code or chat cancels it so surfaces keep their own personality.
  // - Thinking state is saved per mode: Chat remembers its own switch,
  //   Work/Code remember their own depth; switching away and back restores
  //   that mode's own state.
  unsubscribers.push(
    useAppStore.subscribe((state, prev) => {
      const chat = store.getState();
      // 一次性工具策略是模式作用域：切换模式即失效，避免 Code 武装的 /tool 泄漏到 Work/Chat。
      if (state.sidebarMode !== prev.sidebarMode) chat.setPendingToolChoice(null);
      if (state.sidebarMode === 'chat' && prev.sidebarMode !== 'chat') chat.setPendingPlanMode(false);
      if (state.sidebarMode === 'code' && prev.sidebarMode === 'work') chat.setPendingPlanMode(false);
      if (state.sidebarMode === 'work' && prev.sidebarMode !== 'work') chat.setPendingPlanMode(true);
      if (state.sidebarMode === prev.sidebarMode) return;

      // 1) 把离开的模式当前状态快照存下来
      const prevPref = {
        isDeepThink: chat.isDeepThink,
        reasoningEffort: chat.reasoningEffort,
      };
      // 2) 恢复进入的模式自己保存的状态；没有快照时默认思考开启。
      //    Chat 已去掉思考深度，进入 Chat 时强度固定为 high。
      const enteringChat = state.sidebarMode === 'chat';
      const savedPref = chat.modeThinkingPrefs[state.sidebarMode];
      store.setState({
        modeThinkingPrefs: {
          ...chat.modeThinkingPrefs,
          [prev.sidebarMode]: prevPref,
        },
        isDeepThink: savedPref?.isDeepThink ?? true,
        reasoningEffort: enteringChat ? 'high' : (savedPref?.reasoningEffort ?? chat.reasoningEffort),
      });
    }),
  );

  // A brand-new task in Work mode re-arms plan mode — each work item is
  // expected to start with a plan. (The user can still cancel the pill for
  // one send.)
  unsubscribers.push(
    store.subscribe((state, prev) => {
      if (state.pendingNewTask && !prev.pendingNewTask && useAppStore.getState().sidebarMode === 'work') {
        store.getState().setPendingPlanMode(true);
      }
    }),
  );

  // Auto-save session when streaming completes
  let wasStreaming = false;
  unsubscribers.push(
    store.subscribe((state) => {
      // Skip when isStreaming hasn't changed — most set() calls are text chunks
      if (state.isStreaming === wasStreaming) return;
      wasStreaming = state.isStreaming;

      if (!state.isStreaming && state.messages.length > 0) {
        // Snapshot session metadata NOW. The timer below fires 500ms later —
        // by then the user may have started a new conversation (messages
        // cleared → the save would silently drop the finished session) or
        // switched modes (which would stamp the session with the wrong mode).
        const snapshot = {
          sessionId: useSessionStore.getState().currentSessionId,
          messages: state.messages,
          model: state.selectedModel,
          projectRoot: state.currentProjectPath || useSettingsStore.getState().projectPath || undefined,
          mode: useAppStore.getState().sidebarMode,
        };
        setTimeout(() => {
          const s = store.getState();
          if (!s.isStreaming && snapshot.sessionId) {
            // 用户可能在 500ms 内删除了该会话——已删会话不能被自动保存复活。
            if (!isSessionDeleted(snapshot.sessionId)) {
              useSessionStore
                .getState()
                .saveSession(
                  snapshot.messages,
                  snapshot.model,
                  snapshot.projectRoot,
                  snapshot.mode,
                  snapshot.sessionId,
                );
            }
          }
        }, 500);
      }
    }),
  );
}

export function disposeChatStoreSideEffects(): void {
  for (const unsub of unsubscribers) unsub();
  unsubscribers = [];
  registered = false;
}
