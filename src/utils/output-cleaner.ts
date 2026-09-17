/**
 * Clean and normalize AI/Agent output text.
 * Applied at render time so raw content is preserved in the store.
 */

// ANSI escape sequences from terminal output
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

// Zero-width and invisible Unicode characters (expanded set:
// ZWSP, ZWNJ, ZWJ, LRM, RLM, BOM, word joiner, invisible operators,
// soft hyphen, bidi isolates/controls, Arabic letter mark)
const ZERO_WIDTH_RE = /[​-‏﻿⁠-⁤­⁦-⁩‪-‮؜]/g;

// Carriage returns not followed by newline
const CR_RE = /\r(?!\n)/g;

// Trailing whitespace per line
const TRAILING_WS_RE = /[ \t]+$/gm;

// More than 2 consecutive blank lines → collapse to 2
const EXCESSIVE_BLANK_LINES_RE = /\n{3,}/g;

// 扩展思考 XML 块
const THINKING_BLOCK_RE = /<thinking>[\s\S]*?<\/thinking>/gi;

// Legacy XML-format tool call blocks (occasional model hallucination)
const LEGACY_TOOL_BLOCK_RE = /<\/?(?:function_call|tool_call|invoke|parameter)[^>]*>/gi;

// DSML 风格的工具调用排练块（纯对话通道没有工具时，模型偶尔把"假调用"写成文本）
const DSML_BLOCK_RE = /<\s*[｜|\s]*DSML[｜|\s]*(?:tool_?\s*)?calls[^>]*>[\s\S]*?<\/\s*[｜|\s]*DSML[｜|\s]*(?:tool_?\s*)?calls[^>]*>/gi;
const DSML_UNTERMINATED_RE = /<\s*[｜|\s]*DSML[｜|\s]*(?:tool_?\s*)?calls[^>]*>[\s\S]*$/i;
const DSML_TAG_RE = /<\/?\s*[｜|]*DSML\b[^>]*>/gi;

// Chat template markers that models occasionally leak into output
// (<|im_start|>, <|im_end|>, <|assistant|>, <|user|>, <|system|>, etc.)
const CHAT_TEMPLATE_RE = /<\|[^|]*\|>/g;

// XML processing instruction remnants
const XML_PI_RE = /<\?xml[\s\S]*?\?>/gi;

// DOCTYPE remnants
const DOCTYPE_RE = /<!DOCTYPE[^>]*>/gi;

// <FINAL_ANSWER> safety net — should already be stripped in the backend
// but remove here too as defense-in-depth
const FINAL_ANSWER_RE = /<FINAL_ANSWER>/gi;

/**
 * Lightweight clean for streaming content — only strips ANSI codes
 * and zero-width characters. Does NOT apply block-level transforms
 * that could produce partial results mid-stream.
 */
export function cleanStreamChunk(chunk: string): string {
  return chunk
    .replace(ANSI_RE, '')
    .replace(ZERO_WIDTH_RE, '')
    .replace(DSML_TAG_RE, '')
    .replace(CHAT_TEMPLATE_RE, '')
    .replace(CR_RE, '\n')
    .replace(FINAL_ANSWER_RE, '');
}

/**
 * Full clean for final (non-streaming) content.
 * Returns cleaned text and any extracted thinking blocks separately.
 */
export function cleanOutput(content: string): { cleanedText: string; thinkingBlocks: string[] } {
  const thinkingBlocks: string[] = [];
  let match: RegExpExecArray | null;
  // Extract <thinking>...</thinking> blocks before stripping
  const thinkingRe = /<thinking>([\s\S]*?)<\/thinking>/gi;
  while ((match = thinkingRe.exec(content)) !== null) {
    thinkingBlocks.push(match[1].trim());
  }

  const cleanedText = content
    .replace(THINKING_BLOCK_RE, '')
    .replace(ANSI_RE, '')
    .replace(ZERO_WIDTH_RE, '')
    .replace(DSML_BLOCK_RE, '')
    .replace(DSML_UNTERMINATED_RE, '')
    .replace(LEGACY_TOOL_BLOCK_RE, '')
    .replace(DSML_TAG_RE, '')
    .replace(CHAT_TEMPLATE_RE, '')
    .replace(XML_PI_RE, '')
    .replace(DOCTYPE_RE, '')
    .replace(FINAL_ANSWER_RE, '')
    .replace(CR_RE, '\n')
    .replace(TRAILING_WS_RE, '')
    .replace(EXCESSIVE_BLANK_LINES_RE, '\n\n')
    .trim();

  return { cleanedText, thinkingBlocks };
}
