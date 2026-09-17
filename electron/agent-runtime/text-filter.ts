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
  return (chunk: string): string => {
    let out = '';
    let rest = chunk;
    while (rest.length > 0) {
      if (swallowing) {
        // Look for the end of the rehearsal block. Models close it with
        // </function>, or just run into their stop marker.
        const close = rest.match(/<\/function>|<\/FINAL_ANSWER>/i);
        if (!close || close.index === undefined) {
          rest = ''; // whole remainder is inside the swallowed block
        } else {
          rest = rest.slice(close.index + close[0].length);
          swallowing = false;
        }
      } else {
        const open = rest.search(/<function>/i);
        if (open === -1) {
          out += rest;
          rest = '';
        } else {
          out += rest.slice(0, open);
          rest = rest.slice(open).replace(/^<function>/i, '');
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
