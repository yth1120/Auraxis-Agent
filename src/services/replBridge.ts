/**
 * replBridge — Formalized IPC bridge for the permission interceptor flow.
 *
 * When the backend emits WAITING_FOR_PERMISSION (via permission:request),
 * this bridge fans out to registered listeners and provides typed response
 * methods that resolve the backend's pending Promise with surgical precision.
 *
 * Architecture:
 *   Backend requestPermission() promise
 *     → win.webContents.send('permission:request', req)
 *        → PermissionBridge.onRequest(callback)
 *           → useAgentStore.addAgentPermission(req)
 *              → InlinePermissionCard (in AgentConversation)
 *                 → PermissionBridge.respond(requestId, allowed)
 *                    → ipcRenderer.invoke('permission:respond', ...)
 *                       → backend resolve(allowed)
 */

import type { PermissionRequest, PermissionRule } from '../types/advanced';

export type PermissionBridgeStatus = 'idle' | 'waiting';

type PermissionListener = (request: PermissionRequest) => void;

class PermissionBridge {
  private listeners = new Set<PermissionListener>();
  private currentStatus: PermissionBridgeStatus = 'idle';
  private statusListeners = new Set<(status: PermissionBridgeStatus) => void>();

  /** Subscribe to incoming permission requests. Returns unsubscribe function. */
  onRequest(callback: PermissionListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /** Subscribe to bridge status changes (idle ↔ waiting). */
  onStatusChange(callback: (status: PermissionBridgeStatus) => void): () => void {
    this.statusListeners.add(callback);
    callback(this.currentStatus);
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  get status(): PermissionBridgeStatus {
    return this.currentStatus;
  }

  /** Called by the IPC listener when backend emits a permission request. */
  _dispatch(request: PermissionRequest): void {
    this._setStatus('waiting');
    for (const listener of this.listeners) {
      try {
        listener(request);
      } catch {
        /* isolate listener failures */
      }
    }
  }

  /** Respond to a pending permission request — resolves the backend Promise. */
  async respond(requestId: string, allowed: boolean): Promise<void> {
    await window.electronAPI?.permission?.respond(requestId, allowed);
  }

  /** Add a permission rule scoped to an active request. */
  async addRule(rule: PermissionRule, requestId: string): Promise<boolean> {
    const result = await window.electronAPI?.permission?.addRule(rule, requestId);
    return result?.ok ?? false;
  }

  /** Fetch all stored permission rules. */
  async getRules(): Promise<PermissionRule[]> {
    const result = await window.electronAPI?.permission?.getRules();
    return (result?.ok ? result.data : []) ?? [];
  }

  /** Notify the bridge that the queue is empty — returns to idle. */
  _setStatus(status: PermissionBridgeStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        /* isolate */
      }
    }
  }
}

/** Singleton bridge instance. */
export const permissionBridge = new PermissionBridge();
