/**
 * spill.ts — oversized tool-output spill store （溢出落盘）.
 *
 * When a tool result would otherwise flood the model context, the step engine
 * writes the full payload to a private session-scoped file and keeps only a
 * short preview + spill path in the message. The agent can retrieve the full
 * content later with the ReadSpill tool.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';

export interface SpillRef {
  path: string;
  bytes: number;
}

function spillDir(): string {
  if (process.env.AURAXIS_SPILL_DIR) return process.env.AURAXIS_SPILL_DIR;
  return path.join(app.getPath('userData'), 'spill');
}

function safeSegment(s: string | undefined, fallback: string): string {
  if (!s) return fallback;
  const cleaned = s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return cleaned || fallback;
}

/** Resolve a spill path strictly inside the spill root (throws on escape). */
export function resolveSpillPath(filePath: string): string {
  const root = path.resolve(spillDir());
  const target = path.resolve(root, filePath);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('spill 路径越界');
  }
  return target;
}

/** Persist oversized tool output and return a locator the model can ReadSpill. */
export async function writeSpill(
  content: string,
  meta: { sessionId?: string; toolName?: string; toolCallId?: string } = {},
): Promise<SpillRef> {
  const dir = spillDir();
  const session = safeSegment(meta.sessionId, 'shared');
  const tool = safeSegment(meta.toolName, 'tool');
  const targetDir = path.join(dir, session);
  await fs.mkdir(targetDir, { recursive: true });
  const file = path.join(targetDir, `${tool}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  await fs.writeFile(file, content, 'utf8');
  return { path: file, bytes: Buffer.byteLength(content, 'utf8') };
}

/** Read a spill file back (bounded to 1 MB to keep the response sane). */
export async function readSpill(filePath: string, maxChars = 1_000_000): Promise<{ content: string; bytes: number }> {
  const target = resolveSpillPath(filePath);
  const raw = await fs.readFile(target, 'utf8');
  const content = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…（spill 读取达到上限）` : raw;
  return { content, bytes: Buffer.byteLength(raw, 'utf8') };
}
