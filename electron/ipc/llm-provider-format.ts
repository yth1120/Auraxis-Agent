/** llm-provider-format.ts — provider-neutral tool schema and content formatting. */
import type { ToolDef } from '../tool-defs';
import type { LoopMessage } from './agent-loop-types';
import { modelSupportsImageInput } from '../types';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 递归归一化 strict schema：每个对象节点都补齐 required + additionalProperties，
 *  避免嵌套空对象被 DeepSeek 拒绝。 */
function normalizeStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'default' || key === 'properties' || key === 'required' || key === 'additionalProperties') continue;
    out[key] = isPlainObject(value) ? normalizeStrictSchema(value) : value;
  }
  const normalizedProperties: Record<string, unknown> = {};
  out.properties = normalizedProperties;
  for (const [k, v] of Object.entries(properties)) {
    normalizedProperties[k] = isPlainObject(v) ? normalizeStrictSchema(v) : v;
  }
  out.required = Object.keys(properties);
  out.additionalProperties = false;
  return out;
}

/** 递归清洗 schema：任何「没有可用属性的 object 节点」都返回 null（由父级丢弃），
 *  保证发给 DeepSeek 的请求里不会出现空对象 —— 这是 400
 *  “An object with no properties is not allowed” 的直接来源。 */
function sanitizeSchemaForApi(node: unknown): Record<string, unknown> | null {
  if (!isPlainObject(node)) return node as unknown as Record<string, unknown>;
  const n = node;
  const out: Record<string, unknown> = { ...n };

  if (n.type === 'object' || n.properties !== undefined) {
    const props = n.properties;
    if (!isPlainObject(props) || Object.keys(props).length === 0) return null;
    const cleanedProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      const cleaned = sanitizeSchemaForApi(value);
      if (cleaned !== null) cleanedProps[key] = cleaned;
    }
    if (Object.keys(cleanedProps).length === 0) return null;
    out.properties = cleanedProps;
    if (Array.isArray(n.required)) {
      out.required = n.required.filter((k: unknown) => typeof k === 'string' && k in cleanedProps);
    }
  }

  if (n.items !== undefined) {
    const cleanedItems = sanitizeSchemaForApi(n.items);
    if (cleanedItems === null) delete out.items;
    else out.items = cleanedItems;
  }

  return out;
}

export function buildOpenAIFormatTools(tools: ToolDef[], opts?: { strict?: boolean }) {
  return tools.map((t) => {
    const cleaned = sanitizeSchemaForApi(t.input_schema);
    const strict = !!opts?.strict && cleaned !== null;
    return {
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        ...(strict ? { strict: true } : {}),
        parameters:
          cleaned === null
            ? { type: 'object' }
            : strict
              ? normalizeStrictSchema(cleaned)
              : {
                  ...cleaned,
                  additionalProperties: cleaned.additionalProperties ?? false,
                },
      },
    };
  });
}

export function buildAnthropicFormatTools(tools: ToolDef[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

export function isAnthropicFormatEndpoint(apiBase: string): boolean {
  return apiBase.includes('/messages') || apiBase.includes('/anthropic/');
}

/**
 * Self-heal tool_calls pairing before every OpenAI-format request.
 * The API hard-rejects (HTTP 400) a history where an assistant message with
 * `tool_calls` is not immediately followed by one `tool` message per id.
 * Pairing breaks in real paths: deviance/anyError user-message injections land
 * between the assistant and its tool replies, Replan results are pushed after
 * injected messages, and compression/follow-up rebuilds can drop replies.
 * Instead of chasing every producer, repair at the gate:
 *  - tool replies separated from their assistant → reordered back adjacent
 *    (interleaved user/system messages are deferred to after the tool block)
 *  - missing tool replies → synthesize an error stub
 *  - orphaned/duplicate tool messages (no pending id) → drop
 */
export function sanitizeToolCallPairing(messages: LoopMessage[]): LoopMessage[] {
  const out: LoopMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const m = messages[i];

    if (m.role === 'tool') {
      // Orphan: no preceding assistant declared this id (or already answered) — drop.
      i++;
      continue;
    }

    out.push(m);
    i++;

    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;

    const pending = new Set<string>(
      m.tool_calls.map((tc) => (typeof tc?.id === 'string' ? tc.id : '')).filter((id): id is string => id.length > 0),
    );
    const deferred: LoopMessage[] = [];

    // Scavenge forward for this assistant's tool replies; stop at the next
    // assistant turn (tool replies never cross an assistant boundary).
    while (i < messages.length && pending.size > 0) {
      const n = messages[i];
      if (n.role === 'assistant') break;
      if (n.role === 'tool') {
        if (n.tool_call_id && pending.has(n.tool_call_id)) {
          out.push(n);
          pending.delete(n.tool_call_id);
        }
        // unknown/duplicate id — drop
      } else {
        deferred.push(n);
      }
      i++;
    }

    for (const id of pending) {
      out.push({ role: 'tool', tool_call_id: id, content: 'Error: 工具结果丢失（已自动修补）' });
    }
    out.push(...deferred);
  }

  return out;
}

/**
 * Build a model-visible tool-result content value. A tool result whose output
 * carries a `data:` image (e.g. ReadImage) is converted into an OpenAI-style
 * content array with an `image_url` part plus a compact text summary, so
 * image-capable models actually see the pixels instead of a base64 blob.
 */
function toolResultMeta(output: unknown): { image: string | null; obj: Record<string, unknown> } | null {
  const obj = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>;
  const image = typeof obj.image === 'string' && obj.image.startsWith('data:image/') ? obj.image : null;
  return { image, obj };
}

export function buildToolResultText(output: unknown, error?: string): string {
  if (error) return `Error: ${error}`;
  const metaWithImage = toolResultMeta(output);
  if (!metaWithImage) return 'null';
  if (!metaWithImage.image) return JSON.stringify(output) ?? 'null';
  const { obj } = metaWithImage;
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'image') continue;
    meta[k] = v;
  }
  return [
    `[图片] ${String(obj.mime ?? 'image')}`,
    `文件: ${String(obj.file_path ?? obj.attachment_id ?? '')}`,
    `大小: ${Number(obj.bytes) || 0} 字节`,
    ...(Object.keys(meta).length > 0 ? [JSON.stringify(meta)] : []),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function buildToolResultContent(output: unknown, error?: string): string | Array<Record<string, unknown>> {
  if (error) return `Error: ${error}`;
  const metaWithImage = toolResultMeta(output);
  if (!metaWithImage?.image) return JSON.stringify(output) ?? 'null';
  return [
    { type: 'image_url', image_url: { url: metaWithImage.image } },
    { type: 'text', text: buildToolResultText(output) },
  ];
}

/**
 * Provider-specific normalization of content arrays: drop image parts for
 * non-vision DeepSeek routes, and translate OpenAI `image_url` parts into
 * Anthropic image blocks on the Anthropic wire format.
 */
export function normalizeProviderContent(m: LoopMessage, provider: 'openai' | 'anthropic', model: string): LoopMessage {
  if (!Array.isArray(m.content)) return m;
  let parts: Array<Record<string, unknown>> | string = m.content;
  const isDeepSeek = model.toLowerCase().startsWith('deepseek-');
  const supportsImage = modelSupportsImageInput(model);
  const hasImage =
    Array.isArray(parts) && parts.some((p) => p.type === 'image_url' || p.type === 'image' || p.type === 'file');
  if (hasImage && Array.isArray(parts) && (!supportsImage || (isDeepSeek && m.role !== 'user'))) {
    parts = parts.filter((p) => !['image_url', 'image', 'file'].includes(String(p.type ?? '')));
  }
  if (Array.isArray(parts) && isDeepSeek && supportsImage) {
    parts = parts.filter((p) => {
      if (p.type !== 'image_url') return true;
      const image = isPlainObject(p.image_url) ? p.image_url : {};
      const url = String(image.url ?? '');
      const mime = /^data:image\/([^;]+);/i.exec(url);
      return !mime || ['jpeg', 'png', 'gif', 'webp'].includes(mime[1].toLowerCase());
    });
  }
  if (m.role === 'tool' && Array.isArray(parts)) {
    parts = parts
      .map((p) => (p.type === 'text' ? String(p.text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (provider === 'anthropic' && Array.isArray(parts)) {
    parts = parts.map((p) => {
      if (p.type === 'image_url') {
        const image = isPlainObject(p.image_url) ? p.image_url : {};
        const url = String(image.url ?? '');
        if (!url) return p;
        const match = /^data:([^;]+);base64,(.*)$/.exec(url);
        return match
          ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
          : { type: 'image', source: { type: 'url', url } };
      }
      if (p.type === 'text') return { type: 'text', text: String(p.text ?? '') };
      return p;
    });
  }
  return { ...m, content: parts };
}
