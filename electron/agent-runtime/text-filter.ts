/**
 * Strip model artifacts (thinking tags, control chars, etc.) from streaming text.
 * Applied per-chunk before emitting to the frontend.
 *
 * Tool call detection is handled natively via the SSE delta.tool_calls protocol
 * with strict mode enabled (DeepSeek beta endpoint). No regex-based tool call
 * interception is performed — tool_calls are parsed directly from the API response.
 */

// Full <thinking>...</thinking> block — strip tag AND content during streaming
// (the renderer's cleanOutput extracts them for separate display, but streaming
// chunks must not leak internal reasoning into the visible output)
const THINKING_BLOCK_RE = /<thinking>[\s\S]*?<\/thinking>/gi;

// Defensive text-cleanup patterns (NOT tool call detection).
// Strict mode + native tool_calls eliminates the need for XML-format tool call
// artifact stripping — these patterns only handle non-tool-call text artifacts.
const ARTIFACT_PATTERNS: RegExp[] = [
  // DeepSeek R1 / Qwen thinking block (full strip: tag + content)
  /<think>[\s\S]*?<\/think>/gi,
  // XML-style tool-call rehearsal the model sometimes writes into the text
  // channel alongside (or instead of) native tool_calls — e.g.
  // "<function>\n<TodoWrite>\n<tasks>[...]". Strip closed blocks and an
  // unterminated trailing block (native tool_calls take over after it).
  /<function>[\s\S]*?<\/function>/gi,
  /<function>[\s\S]*$/i,
  // DSML 风格的工具调用排练块：纯对话通道没有工具时，模型偶尔把一次"假调用"
  // 写成文本（`… DSML …`）。整块丢弃，不留标签碎片。
  /<\s*[｜|\s]*DSML[｜|\s]*(?:tool_?\s*)?calls[^>]*>[\s\S]*?<\/\s*[｜|\s]*DSML[｜|\s]*(?:tool_?\s*)?calls[^>]*>/gi,
  /<\s*[｜|\s]*DSML[｜|\s]*(?:tool_?\s*)?calls[^>]*>[\s\S]*$/i,
  // 兜底：上面整块匹配按"最近闭合"截断后可能残留配对标签，这里一并清掉。
  /<\/?\s*[｜|\s]*DSML[^>]*>/gi,
  // Chat template markers that models occasionally leak into output
  // (<|im_start|>, <|im_end|>, <|assistant|>, <|user|>, <|system|>, etc.)
  /<\|[^|]*\|>/g,
  // Zero-width and invisible characters (expanded set)
  /[​-‏﻿⁠⁡⁢⁣⁤­⁦-⁩‪-‮؜]/g,
  // Leftover SSE markers that might leak through
  /^data:\s*/gm,
];

export function stripModelArtifacts(text: string): string {
  let cleaned = text;
  // Strip full thinking blocks first (tags + content)
  cleaned = cleaned.replace(THINKING_BLOCK_RE, '');
  // Then strip other artifacts
  for (const re of ARTIFACT_PATTERNS) {
    cleaned = cleaned.replace(re, '');
  }
  // Stop-signal markers are protocol internals — never show them
  cleaned = cleaned.replace(/<\/?FINAL_ANSWER>/gi, '');
  // Collapse consecutive blank lines (more than 2) into 2
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned;
}

/**
 * Stateful per-run stream filter. The model sometimes "rehearses" the whole
 * task as an XML tool-call transcript inside the TEXT channel (e.g.
 * "<function>\n<TodoWrite>\n<tasks>[...]" … "</TodoWrite>\n总结…<FINAL_ANSWER>")
 * while ALSO emitting native tool_calls. A stateless per-chunk regex cannot
 * catch blocks that span chunk boundaries — this closure carries the
 * "inside-a-rehearsal" state across chunks.
 *
 * Create ONE instance per agent/query run and pipe every text chunk through it.
 */
export function createStreamFilter(): (chunk: string) => string {
  let swallowing = false;
  /**
   * 未定性的尾巴：可能是一个被逐 token 拆散的排练块开口前缀（`<…DS`）。
   * 直接放行会漏出标记碎片，所以先扣住，等后续 chunk 补齐或确认不是标记。
   */
  let pending = '';
  const OPEN_RE = /<function>|<\s*[｜|\s]*DSML[｜|\s]*(?:tool_?\s*)?calls[^>]*>/i;
  const CLOSE_RE = /<\/function>|<\/FINAL_ANSWER>|<\/\s*[｜|\s]*DSML[｜|\s]*(?:tool_?\s*)?calls[^>]*>/i;
  /** 尾部未闭合、且只由标签字符组成的片段（`<`、`<｜｜DS`、`<function`）。 */
  const partialTagSuffixLength = (text: string): number => {
    const idx = text.lastIndexOf('<');
    if (idx < 0) return 0;
    const suffix = text.slice(idx);
    return /^<[｜|\w_\s]{0,63}$/.test(suffix) ? suffix.length : 0;
  };
  return (chunk: string): string => {
    let out = '';
    let rest = pending + chunk;
    pending = '';
    while (rest.length > 0) {
      if (swallowing) {
        // Look for the end of the rehearsal block. Models close it with
        // </function>, an outermost DSML closer (…calls / …invoke), or their
        // stop marker.
        const close = rest.match(CLOSE_RE);
        if (!close || close.index === undefined) {
          rest = ''; // whole remainder is inside the swallowed block
        } else {
          rest = rest.slice(close.index + close[0].length);
          swallowing = false;
        }
      } else {
        // DSML 排练块的开口（纯对话通道没有工具时模型会把它写成文本）。
        const open = rest.search(OPEN_RE);
        if (open === -1) {
          // 没有完整开口：只放行确定不是标记前缀的部分，其余留到下一 chunk。
          const hold = partialTagSuffixLength(rest);
          out += rest.slice(0, rest.length - hold);
          pending = rest.slice(rest.length - hold);
          rest = '';
        } else {
          out += rest.slice(0, open);
          rest = rest
            .slice(open)
            .replace(/^<function>/i, '')
            .replace(/^<\s*[｜|\s]*DSML[｜|\s]*(?:tool_?\s*)?calls[^>]*>/i, '');
          swallowing = true;
        }
      }
    }
    // Orphaned closing tags from a rehearsal that started before this run's
    // filter saw the opening (e.g. "</TodoWrite>" at line start) — drop them.
    out = out.replace(/^\s*<\/[A-Za-z_]+>\s*$/gm, '');
    return stripModelArtifacts(out);
  };
}

/**
 * Check if a chunk is entirely artifacts (should be dropped).
 */
export function isAllArtifacts(text: string): boolean {
  let stripped = text.replace(THINKING_BLOCK_RE, '');
  for (const re of ARTIFACT_PATTERNS) {
    stripped = stripped.replace(re, '');
  }
  return stripped.trim().length === 0;
}
