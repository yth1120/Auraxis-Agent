/**
 * tokenizer.ts — DeepSeek 官方离线 tokenizer（deepseek_v3_tokenizer.zip）。
 *
 * 使用官方 tokenizer.json（BPE, vocab 128K + merges 127K）在本地精确估算 token 数，
 * 不依赖网络/API。实现对齐 HuggingFace LlamaTokenizerFast 的字节级 BPE：
 *   1. 按官方 pre_tokenizer 的三个 Split 规则切分（数字、CJK、字节级正则）
 *   2. ByteLevel 字节编码（bytes_to_unicode）
 *   3. 按官方 merges 顺序贪心合并，统计最终 piece 数量
 *
 * added_tokens（如 <｜tool▁calls▁begin｜>、<think>、FIM 标记）按官方定义各计 1 个 token，
 * 在文本中出现时先剥离再对剩余内容做 BPE，避免重复计费。
 */
import { errorText } from './errors';
import { app } from 'electron';
import { secureHandle } from './ipc/trust';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

interface LoadedTokenizer {
  vocab: Map<string, number>;
  merges: Map<string, number>;
  splitPatterns: RegExp[];
  addPrefixSpace: boolean;
  addedTokens: string[];
}

let cached: LoadedTokenizer | null = null;

function tokenizerAssetPath(): string {
  if (process.env.AURAXIS_TOKENIZER_PATH) return process.env.AURAXIS_TOKENIZER_PATH;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'tokenizer', 'tokenizer.json');
  }
  const dev = path.resolve(app.getAppPath(), 'electron', 'tokenizer', 'tokenizer.json');
  if (existsSync(dev)) return dev;
  // vitest 直跑 TS 时的回退：__dirname 指向 electron/
  const test = path.resolve(__dirname, 'tokenizer', 'tokenizer.json');
  return existsSync(test) ? test : dev;
}

function bytesToUnicode(): Map<number, string> {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs: number[] = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n += 1;
    }
  }
  const map = new Map<number, string>();
  for (let i = 0; i < bs.length; i++) map.set(bs[i], String.fromCharCode(cs[i]));
  return map;
}

let byteEncoder: Map<number, string> | null = null;

function getByteEncoder(): Map<number, string> {
  if (!byteEncoder) byteEncoder = bytesToUnicode();
  return byteEncoder;
}

function loadTokenizer(): LoadedTokenizer {
  if (cached) return cached;
  const raw = readFileSync(tokenizerAssetPath(), 'utf-8');
  const json = JSON.parse(raw) as {
    model?: { vocab?: Record<string, number>; merges?: string[] };
    pre_tokenizer?: { pretokenizers?: Array<{ type?: string; pattern?: { Regex?: string }; behavior?: string }> };
    post_processor?: { type?: string; add_prefix_space?: boolean };
    added_tokens?: Array<{ content?: string }>;
  };
  const vocab = new Map<string, number>();
  for (const [token, id] of Object.entries(json.model?.vocab ?? {})) vocab.set(token, id);
  const merges = new Map<string, number>();
  (json.model?.merges ?? []).forEach((pair, index) => merges.set(pair, index));
  const splitPatterns: RegExp[] = [];
  for (const p of json.pre_tokenizer?.pretokenizers ?? []) {
    if (p.type === 'Split' && p.pattern?.Regex) {
      try {
        splitPatterns.push(new RegExp(p.pattern.Regex, 'gu'));
      } catch {
        // 忽略无法编译的规则（保留其余规则）
      }
    }
  }
  const addedSet = new Set<string>();
  for (const at of json.added_tokens ?? []) {
    if (typeof at.content === 'string' && at.content) addedSet.add(at.content);
  }
  cached = {
    vocab,
    merges,
    splitPatterns,
    addPrefixSpace: json.post_processor?.type === 'ByteLevel' && json.post_processor.add_prefix_space !== false,
    addedTokens: [...addedSet].sort((a, b) => b.length - a.length),
  };
  return cached;
}

/** 按官方 Split 规则（behavior=isolated）切分：匹配段与未匹配段都保留为独立片段。 */
function applySplit(input: string, re: RegExp): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    if (match.index > last) out.push(input.slice(last, match.index));
    out.push(match[0]);
    last = match.index + match[0].length;
    if (match[0].length === 0) re.lastIndex += 1;
  }
  if (last < input.length) out.push(input.slice(last));
  return out;
}

function pretokenize(text: string, model: LoadedTokenizer): string[] {
  let pieces = [text];
  for (const re of model.splitPatterns) {
    const next: string[] = [];
    for (const piece of pieces) next.push(...applySplit(piece, re));
    pieces = next;
  }
  return pieces;
}

function byteEncode(text: string): string {
  const encoder = getByteEncoder();
  const bytes = Buffer.from(text, 'utf-8');
  let out = '';
  for (const b of bytes) out += encoder.get(b) ?? String.fromCharCode(b);
  return out;
}

function bpePieceCount(piece: string, model: LoadedTokenizer): number {
  const encoded = byteEncode(piece);
  if (encoded.length === 0) return 0;
  if (model.vocab.has(encoded)) return 1;
  let chars = encoded.split('');
  while (chars.length > 1) {
    let bestPair: string | null = null;
    let bestRank = Infinity;
    for (let i = 0; i < chars.length - 1; i++) {
      const pair = `${chars[i]} ${chars[i + 1]}`;
      const rank = model.merges.get(pair);
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank;
        bestPair = pair;
      }
    }
    if (bestPair === null) break;
    const [left, right] = bestPair.split(' ');
    const next: string[] = [];
    for (let i = 0; i < chars.length; i++) {
      if (i < chars.length - 1 && chars[i] === left && chars[i + 1] === right) {
        next.push(left + right);
        i += 1;
      } else {
        next.push(chars[i]);
      }
    }
    chars = next;
  }
  return chars.length;
}

/** 官方离线 token 计数（近似 API 实际 usage；不含特殊 added_tokens）。 */
export function countTokens(text: string): number {
  if (!text) return 0;
  const model = loadTokenizer();
  let input = text;
  if (model.addPrefixSpace && !input.startsWith(' ')) input = ` ${input}`;
  // 官方 added_tokens（工具调用包裹、<think>、FIM 标记等）各计 1 个 token，先剥离避免重复计费。
  let total = 0;
  for (const added of model.addedTokens) {
    if (!added) continue;
    let index = input.indexOf(added);
    while (index !== -1) {
      total += 1;
      input = input.slice(0, index) + input.slice(index + added.length);
      index = input.indexOf(added);
    }
  }
  for (const piece of pretokenize(input, model)) {
    if (!piece) continue;
    if (model.vocab.has(piece)) {
      total += 1;
    } else {
      total += bpePieceCount(piece, model);
    }
  }
  return total;
}

/** 仅供测试/调试：返回已加载模型的统计信息。 */
export function getTokenizerStats(): {
  vocabSize: number;
  mergeCount: number;
  splitPatterns: number;
  addedTokens: number;
} {
  const model = loadTokenizer();
  return {
    vocabSize: model.vocab.size,
    mergeCount: model.merges.size,
    splitPatterns: model.splitPatterns.length,
    addedTokens: model.addedTokens.length,
  };
}

export function registerTokenizerIpc(): void {
  secureHandle('tokenizer:count', (_event, text: unknown) => {
    if (typeof text !== 'string') return { ok: false, error: 'text 必须为字符串' };
    try {
      return { ok: true, data: countTokens(text) };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });
}
