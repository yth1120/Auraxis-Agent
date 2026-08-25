/**
 * feedback-handlers.ts — session feedback log （会话反馈）.
 * Appends one JSONL record per submission under userData/feedback.
 */
import { errorText } from '../errors';
import { app } from 'electron';
import { secureHandle } from './trust';
import { promises as fs } from 'fs';
import path from 'path';
import { flushTelemetry } from './session-telemetry';
import { captureFeedbackEvidence } from './memory-evidence';

export interface MessageFeedbackRecord {
  messageId: string;
  sessionId: string;
  rating: 'up' | 'down' | null;
  note?: string;
  /** INO 纠错闭环：携带项目路径时，down 评分/备注会固化为证据。 */
  projectPath?: string;
  ts: number;
}

function feedbackDir(): string {
  return process.env.AURAXIS_FEEDBACK_DIR || path.join(app.getPath('userData'), 'feedback');
}

function messageFile(): string {
  return path.join(feedbackDir(), 'messages.jsonl');
}

export async function appendFeedback(text: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: '反馈内容为空' };
  }
  try {
    const dir = process.env.AURAXIS_FEEDBACK_DIR || path.join(app.getPath('userData'), 'feedback');
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(
      path.join(dir, 'feedback.jsonl'),
      `${JSON.stringify({ ts: Date.now(), text: text.trim().slice(0, 4000) })}\n`,
      'utf8',
    );
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: errorText(e) };
  } finally {
    // Feedback is the user's explicit opt-in moment — flush captured telemetry.
    void flushTelemetry(true);
  }
}

/** Append (or clear) one per-message rating. `rating: null` removes it. */
export async function appendMessageFeedback(
  record: Omit<MessageFeedbackRecord, 'ts'>,
): Promise<{ ok: boolean; error?: string }> {
  if (!record?.messageId || !record?.sessionId) {
    return { ok: false, error: 'messageId / sessionId 必填' };
  }
  if (record.rating !== 'up' && record.rating !== 'down' && record.rating !== null) {
    return { ok: false, error: 'rating 必须是 up / down / null' };
  }
  try {
    const file = messageFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify({ ...record, ts: Date.now() })}\n`, 'utf8');
    // INO：纠错即证据（best-effort，失败不影响反馈落盘）。
    if (record.projectPath && (record.rating === 'down' || record.note)) {
      try {
        captureFeedbackEvidence({ ...record, ts: Date.now() });
      } catch {
        /* evidence capture is best-effort */
      }
    }
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: errorText(e) };
  }
}

/** Latest rating per message for one session (last write wins). */
export async function listMessageFeedback(sessionId: string): Promise<MessageFeedbackRecord[]> {
  if (!sessionId) return [];
  try {
    const raw = await fs.readFile(messageFile(), 'utf8');
    const byMessage = new Map<string, MessageFeedbackRecord>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as MessageFeedbackRecord;
        if (r?.sessionId !== sessionId || !r?.messageId) continue;
        byMessage.set(r.messageId, r);
      } catch {
        /* skip corrupt */
      }
    }
    return [...byMessage.values()].filter((r) => r.rating !== null);
  } catch {
    return [];
  }
}

export function registerFeedbackHandlers() {
  secureHandle('feedback:submit', async (_e, text: string) => appendFeedback(text));
  secureHandle('feedback:message', async (_e, record: Omit<MessageFeedbackRecord, 'ts'>) => {
    const r = await appendMessageFeedback(record);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });
  secureHandle('feedback:messageList', async (_e, sessionId: string) => {
    return { ok: true, data: await listMessageFeedback(sessionId) };
  });
}
