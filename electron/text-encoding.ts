/**
 * text-encoding.ts — Windows child-process output decoding.
 *
 * Native tools (Node, Git Bash, Python) emit UTF-8 while cmd.exe built-ins
 * emit the OEM/GBK codepage. A fixed 'cp936' decode turns UTF-8 text into
 * mojibake, and a fixed UTF-8 decode mangles GBK. The smart decoder buffers a
 * short prefix, locks the stream's encoding (strict UTF-8 when decodable,
 * otherwise GBK), then decodes with the lock. GBK characters split across
 * chunk boundaries are held back until their second byte arrives.
 */
import * as iconv from 'iconv-lite';

/** Number of trailing bytes that belong to an incomplete GBK character. */
function gbkTrailingPending(buf: Buffer): number {
  let lastLeadAt = -1;
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b >= 0x81 && b <= 0xfe) {
      lastLeadAt = i;
      i += 2;
    } else {
      i += 1;
    }
  }
  return lastLeadAt >= 0 && lastLeadAt + 1 >= buf.length ? 1 : 0;
}

export interface OutputDecoder {
  decode(chunk: Buffer): string;
  /** Decode whatever tail was held back at end-of-stream. */
  flush(): string;
}

export function createOutputDecoder(): OutputDecoder {
  // Lock the stream's encoding once enough bytes have been seen. UTF-8
  // streams are the norm for Node/Git Bash/Python; GBK covers cmd built-ins.
  let mode: 'utf8' | 'gbk' | null = null;
  let pending: Buffer = Buffer.alloc(0);
  const utf8Stream = new TextDecoder('utf-8', { fatal: true });

  function tryUtf8(buf: Buffer): string | null {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return null;
    }
  }

  return {
    decode(chunk: Buffer): string {
      if (mode === 'utf8') {
        return utf8Stream.decode(chunk, { stream: true });
      }
      const buf = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      if (mode === null && buf.length < 8) {
        pending = buf;
        return '';
      }
      const text = tryUtf8(buf);
      if (text !== null) {
        mode = 'utf8';
        pending = Buffer.alloc(0);
        return text;
      }
      mode = 'gbk';
      pending = Buffer.alloc(0);
      const keep = gbkTrailingPending(buf);
      const head = buf.subarray(0, buf.length - keep);
      pending = buf.subarray(buf.length - keep);
      return iconv.decode(head, 'gbk');
    },

    flush(): string {
      const buf = pending;
      pending = Buffer.alloc(0);
      if (buf.length === 0) return '';
      const text = tryUtf8(buf);
      if (text !== null) return text;
      return iconv.decode(buf, 'gbk');
    },
  };
}
