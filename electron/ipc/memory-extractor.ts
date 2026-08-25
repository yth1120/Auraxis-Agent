/**
 * Memory extractor — analyses completed conversations and extracts
 * structured, durable memories via the LLM for long-term persistence.
 */

import { llmClientInvoke } from './agent-loop';
import type { EvidenceRecord, MemoryRecord } from './memory-db';

// ─── Types ─────────────────────────────────────────────

export interface ExtractedMemory {
  type: 'decision' | 'problem' | 'architecture' | 'preference' | 'progress' | 'context';
  title: string;
  content: string;
  tags: string[];
  importance: number;
  /** Eywa M2：LLM 必须给出支撑本条信念的 evidence id。 */
  evidenceIds?: string[];
}

export interface SessionContext {
  projectPath: string;
  sessionId: string;
  messages: { role: string; content: string }[];
  planHistory?: { title?: string; todos?: { content: string; status: string }[] }[];
  toolResults?: { toolName: string; summary: string; success: boolean }[];
  existingMemories?: Pick<MemoryRecord, 'id' | 'title' | 'content' | 'type' | 'tags' | 'importance'>[];
  /** 当前 scope 下已捕获的不可变证据（M2 硬锚点引用来源）。 */
  evidence?: EvidenceRecord[];
}

export interface ExtractorConfig {
  model: string;
  apiKey: string;
  apiBase: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ─── Helpers ───────────────────────────────────────────

function buildConversationSummary(messages: { role: string; content: string }[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : '系统';
    const text = m.content.slice(0, 400);
    lines.push(`[${role}] ${text}`);
  }
  return lines.join('\n');
}

function buildExistingMemoriesText(
  memories: Pick<MemoryRecord, 'id' | 'title' | 'content' | 'type' | 'tags' | 'importance'>[],
): string {
  if (!memories || memories.length === 0) return '（暂无已有记忆）';
  return memories
    .sort((a, b) => b.importance - a.importance)
    .map((m) => `[${m.type}][重要度${m.importance}] ${m.title}: ${m.content}`)
    .join('\n');
}

function buildToolResultsText(results: { toolName: string; summary: string; success: boolean }[]): string {
  if (!results || results.length === 0) return '（无工具执行记录）';
  return results.map((r) => `[${r.success ? '成功' : '失败'}] ${r.toolName}: ${r.summary}`).join('\n');
}

export function buildEvidenceContextText(evidence: EvidenceRecord[] | undefined): string {
  if (!evidence || evidence.length === 0) return '（暂无证据，只能返回空数组）';
  return evidence
    .slice(0, 60)
    .map((e) => `[${e.id}] (${e.role}) ${e.content.slice(0, 300)}`)
    .join('\n');
}

function buildExtractionPrompt(ctx: SessionContext): string {
  const conversation = buildConversationSummary(ctx.messages);
  const existing = buildExistingMemoriesText(ctx.existingMemories || []);
  const toolResults = buildToolResultsText(ctx.toolResults || []);
  const evidenceText = buildEvidenceContextText(ctx.evidence);

  return `你是一个记忆提取器。请从以下会话中提取所有值得记住的信息，按类型分类：

## 当前项目：${ctx.projectPath}

## 已有的活跃记忆（避免重复）：
${existing}

## 对话历史摘要：
${conversation}

## 执行的任务和结果：
${toolResults}

## 不可变证据（必须引用，evidence_ids 必须来自这里）：
${evidenceText}

请输出一个 JSON 数组（只要 JSON，不要任何其他文字），每个元素包含：
- type: "decision" | "problem" | "architecture" | "preference" | "progress" | "context"
- title: 简短标题（20字以内）
- content: 详细内容（100字以内，包含关键细节）
- tags: 相关标签数组（如 ["react", "auth", "routing"]）
- importance: 1-5（5=项目级关键信息，1=临时上下文）
- evidence_ids: 字符串数组，引用上面证据列表中的 id；每条信念至少 1 个，
  无法引用的内容不要输出

注意：
- 不要重复已有记忆
- 如果有需要更新的记忆（如进度更新），在 content 中标明变化
- 决策偏好如果与已有记忆矛盾，标记为新记忆（importance 更高的保留）
- 如果没有值得保留的新信息，返回空数组 []
- 如果证据列表为空，返回空数组 []

输出格式示例：
[{"type":"decision","title":"使用 React Router v6","content":"项目统一使用 React Router v6，采用 createBrowserRouter API","tags":["react","routing"],"importance":4,"evidence_ids":["evt-1"]}]`;
}

// ─── Deduplication ─────────────────────────────────────

function similarityScore(a: string, b: string): number {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (al === bl) return 1.0;

  // Simple word-overlap Jaccard index
  const aWords = new Set(al.split(/\s+/));
  const bWords = new Set(bl.split(/\s+/));
  const intersection = new Set([...aWords].filter((w) => bWords.has(w)));
  const union = new Set([...aWords, ...bWords]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function deduplicate(
  extracted: ExtractedMemory[],
  existing: Pick<MemoryRecord, 'id' | 'title' | 'content' | 'type' | 'tags' | 'importance'>[],
): ExtractedMemory[] {
  if (!existing || existing.length === 0) return extracted;

  return extracted.filter((newMem) => {
    for (const old of existing) {
      const titleSim = similarityScore(newMem.title, old.title);
      const contentSim = similarityScore(newMem.content, old.content);
      // Same title + highly similar content → skip
      if (titleSim === 1.0 || (titleSim > 0.7 && contentSim > 0.8)) {
        return false;
      }
    }
    return true;
  });
}

// ─── Parsing ───────────────────────────────────────────

function parseExtractedJson(raw: string): ExtractedMemory[] {
  // Strip markdown fences if present
  let json = raw.trim();
  if (json.startsWith('```')) {
    json = json
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, '')
      .trim();
  }

  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];

    return arr
      .filter((item): item is Record<string, unknown> => isRecord(item) && !!item.title && !!item.content)
      .map((item) => ({
        type: item.type as ExtractedMemory['type'],
        title: String(item.title).slice(0, 100),
        content: String(item.content).slice(0, 500),
        tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 10) : [],
        importance: Math.min(5, Math.max(1, Number(item.importance) || 3)),
        evidenceIds: Array.isArray(item.evidence_ids) ? item.evidence_ids.map(String).filter(Boolean).slice(0, 8) : [],
      }));
  } catch {
    return [];
  }
}

// ─── Main export ───────────────────────────────────────

export async function extractMemories(ctx: SessionContext, config: ExtractorConfig): Promise<ExtractedMemory[]> {
  const prompt = buildExtractionPrompt(ctx);

  try {
    const result = await llmClientInvoke({
      model: config.model,
      apiKey: config.apiKey,
      apiBase: config.apiBase,
      systemPrompt: '你是一个精确的记忆提取器。只输出有效的 JSON 数组，不要任何解释。',
      messages: [{ role: 'user', content: prompt }],
      tools: [], // No tools — pure text extraction
      signal: new AbortController().signal,
    });

    if (!result || !result.rawText) return [];

    const memories = parseExtractedJson(result.rawText);
    return deduplicate(memories, ctx.existingMemories || []);
  } catch {
    return [];
  }
}
