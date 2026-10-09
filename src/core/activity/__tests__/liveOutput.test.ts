/**
 * liveOutput.test.ts — 运行中终端的实时文本处理。
 *
 * 钉住三件容易出事的事：
 *   · 截断只落在**行边界**或转义序列起点（否则界面会出现半截 ANSI 乱码）；
 *   · 行数/字节数是**真实计数**（中文按 UTF-8 字节算，不是字符串长度）；
 *   · 没超限时一个字符都不动（不能悄悄改写用户看到的内容）。
 */
import { describe, it, expect } from 'vitest';
import { countLines, liveOutputStats, tailForStream, terminalView, STREAM_MAX_CHARS } from '../liveOutput';

describe('countLines', () => {
  it('末尾换行不算新行（"a\\n" 是 1 行，与终端观感一致）', () => {
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(2);
  });

  it('空串与纯换行是 0 行', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('\n')).toBe(0);
  });
});

describe('tailForStream', () => {
  it('没超限时原样返回，且不报截断', () => {
    const text = 'line 1\nline 2\n';
    expect(tailForStream(text, 100)).toEqual({ text, omittedChars: 0, omittedLines: 0 });
  });

  it('超限时从**行首**开始保留（不切断一行）', () => {
    const text = 'aaaa\nbbbb\ncccc\n';
    const out = tailForStream(text, 10);
    expect(out.text).toBe('bbbb\ncccc\n');
    expect(out.omittedChars).toBe(5);
    expect(out.omittedLines).toBe(1);
  });

  it('保留的文本不含半截转义序列（真实 ANSI 输出）', () => {
    const text = '\u001b[32mPASS\u001b[0m auth.test.ts\n\u001b[31mFAIL\u001b[0m user.test.ts\n';
    const out = tailForStream(text, 20);
    // 每行 27 字符 > 20 的窗口，但只切到上一个行首（软上限允许超出一行），
    // 而不是切到"下一个换行"把最后一行也丢掉。
    expect(out.text).toBe('\u001b[31mFAIL\u001b[0m user.test.ts\n');
    expect(out.text).not.toContain('PASS');
  });

  it('切点落在转义序列内部时回退到 ESC（不会渲染出裸参数）', () => {
    // 尾部序列没有终止字节就被切断 → 界面会显示 "38;5;19" 这种裸参数，必须回退。
    const text = 'y'.repeat(200) + '\u001b[38;5;196';
    const out = tailForStream(text, 10);
    expect(out.text).toBe('\u001b[38;5;196');
    expect(out.omittedChars).toBe(200);
  });

  it('序列已闭合则按切点原样开始（不为闭合的序列回退）', () => {
    const text = '\u001b[32m' + 'x'.repeat(200);
    const out = tailForStream(text, 50);
    expect(out.text).toBe('x'.repeat(50));
    expect(out.omittedChars).toBe(155);
    expect(out.text).not.toContain('\u001b');
  });

  it('纯文本且无换行 → 原样截断（宁可显示半行也不显示空）', () => {
    const out = tailForStream('x'.repeat(100), 10);
    expect(out.text).toBe('x'.repeat(10));
    expect(out.omittedChars).toBe(90);
  });

  it('maxChars<=0 时清空并如实报丢弃量', () => {
    expect(tailForStream('a\nb\n', 0)).toEqual({ text: '', omittedChars: 4, omittedLines: 2 });
  });

  it('空输入不进任何分支', () => {
    expect(tailForStream('', 10)).toEqual({ text: '', omittedChars: 0, omittedLines: 0 });
  });

  it('默认上限是 8KB 量级：单帧解析量有界（软上限最多超出一行）', () => {
    const line = `${'x'.repeat(100)}\n`;
    const out = tailForStream(line.repeat(200));
    expect(out.omittedChars).toBeGreaterThan(0);
    expect(out.text.length).toBeLessThanOrEqual(STREAM_MAX_CHARS + line.length);
    expect(out.text.startsWith('x'.repeat(100))).toBe(true); // 从行首开始，不切半行
  });
});

describe('liveOutputStats', () => {
  it('中文按 UTF-8 字节算（字符串长度会明显偏小）', () => {
    const stat = liveOutputStats('通过\n');
    expect(stat.lines).toBe(1);
    expect(stat.bytes).toBe(7); // “通过” 6 字节 + 换行 1 字节
  });

  it('空/未定义 → 0/0（调用方据此不显示芯片）', () => {
    expect(liveOutputStats('')).toEqual({ lines: 0, bytes: 0 });
    expect(liveOutputStats(undefined)).toEqual({ lines: 0, bytes: 0 });
  });
});

describe('terminalView', () => {
  const line = (n: number) => `line ${n}`;

  it('运行中只保留尾部（head+tail 折叠是给读完的日志用的）', () => {
    const text = Array.from({ length: 300 }, (_, i) => line(i)).join('\n');
    const view = terminalView(text, true, 16);
    expect(view.hidden).toBe(0);
    expect(view.tail).toEqual([]);
    expect(view.head.length).toBe(200);
    expect(view.head[0][0].text).toBe('line 100'); // 尾部窗口
  });

  it('运行中的空输出：visible=false（调用方据此不画空框）', () => {
    expect(terminalView('', true, 16)).toMatchObject({ visible: false, head: [] });
    expect(terminalView('   \n', true, 16).visible).toBe(false);
  });

  it('已结束且超长 → 头 8 行 + 折叠计数 + 尾 4 行', () => {
    const text = Array.from({ length: 30 }, (_, i) => line(i)).join('\n');
    const view = terminalView(text, false, 16);
    expect(view.hidden).toBe(14);
    expect(view.head.length).toBe(8);
    expect(view.tail.length).toBe(4);
    expect(view.head[0][0].text).toBe('line 0');
    expect(view.tail[3][0].text).toBe('line 29');
  });

  it('已结束但没超长 → 全量、不折叠', () => {
    const view = terminalView('a\nb', false, 16);
    expect(view).toMatchObject({ hidden: 0, tail: [], visible: true });
    expect(view.head.map((l) => l[0].text)).toEqual(['a', 'b']);
  });

  it('maxLines=Infinity 时不折叠', () => {
    const text = Array.from({ length: 500 }, (_, i) => line(i)).join('\n');
    expect(terminalView(text, false, Infinity).hidden).toBe(0);
  });

  it('结尾换行不算多一行（与 countLines 同一口径）', () => {
    const view = terminalView('a\nb\n', false, 16);
    expect(view.head.length).toBe(2);
  });
});
