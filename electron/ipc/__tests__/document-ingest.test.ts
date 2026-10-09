/**
 * document-ingest.test.ts — 文档切块与入库。
 *
 * 覆盖三件**会静默出错**的事：
 *   1. 切块不能丢内容（丢了就是「检索不到」而不报错）；
 *   2. 重复入库不能产生重复分块，改了内容也不能留下旧分块（旧内容仍被检索到 = 错答案）；
 *   3. 入库的块必须**真的能被读路径检索到** —— 只写证据不写信念时检索会一无所获。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}));

import { chunkDocument, ingestDocument } from '../document-ingest';
import { writeDocument } from '../../document-tools';
import { getBeliefsByScope, listEvidence, searchBeliefs, setBackendModeForTest } from '../memory-db';
import { readForQuery } from '../memory-read';

beforeAll(() => {
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'auraxis-ingest-'));
  setBackendModeForTest('json');
});

/** 真写一个 .docx：入库读的是真实二进制，不能用纯文本假装。 */
async function makeDocx(dir: string, name: string, paragraphs: string[]): Promise<string> {
  const file = path.join(dir, name);
  await writeDocument(file, { blocks: paragraphs.map((text) => ({ type: 'paragraph' as const, text })) });
  return file;
}

describe('chunkDocument — 纯函数切块', () => {
  it('段落合并进预算，且不丢内容', () => {
    const text = ['第一段内容甲', '', '第二段内容乙', '', '第三段内容丙'].join('\n');
    const { chunks, truncated } = chunkDocument(text, { maxChars: 1000 });
    expect(truncated).toBe(false);
    // 三段都在预算内 → 合成一块
    expect(chunks).toHaveLength(1);
    const flat = chunks.map((c) => c.text.replace(/\s/g, '')).join('');
    for (const token of ['第一段内容甲', '第二段内容乙', '第三段内容丙']) expect(flat).toContain(token);
  });

  it('每块都不超过预算（含超长段落与无标点长串）', () => {
    const long = '甲'.repeat(2500);
    const sentences = '这是一句完整的话。'.repeat(40);
    const { chunks } = chunkDocument([long, '', sentences].join('\n'), { maxChars: 200 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(200);
  });

  it('无标点长串按字符硬切，内容一个字不少', () => {
    const text = '乙'.repeat(1000);
    const { chunks } = chunkDocument(text, { maxChars: 300 });
    expect(chunks.map((c) => c.text).join('')).toBe(text);
  });

  it('超过块数上限时明确标记 truncated', () => {
    const { chunks, truncated } = chunkDocument('丙'.repeat(2000), { maxChars: 100, maxChunks: 3 });
    expect(chunks).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it('空白输入 → 0 块；且同一输入两次结果一致', () => {
    expect(chunkDocument('   \n\n   ').chunks).toEqual([]);
    const text = ['甲段落', '', '乙段落', '', '丙段落'].join('\n');
    expect(chunkDocument(text, { maxChars: 30 })).toEqual(chunkDocument(text, { maxChars: 30 }));
  });

  it('序号从 0 起连续', () => {
    const { chunks } = chunkDocument('丁'.repeat(900), { maxChars: 100 });
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });
});

describe('ingestDocument — 入库与替换', () => {
  const SCOPE = 'C:/ingest';

  it('首次入库：块被写进记忆且**读路径能检索到**', async () => {
    const file = await makeDocx(h.userData, 'contract.docx', [
      '付款条款：验收合格后三十日内支付合同总价的百分之七十。',
      '违约责任：逾期交付每日按合同总价的千分之三计算违约金。',
    ]);
    const res = await ingestDocument({ filePath: file, scope: SCOPE });

    expect(res.status).toBe('created');
    expect(res.chunks).toBeGreaterThan(0);
    expect(res.superseded).toBe(0);
    expect(res.docKey).toMatch(/^[0-9a-f]{16}$/);

    // 每块一条信念 + 一条证据（+1 条原始全文证据）
    const beliefs = getBeliefsByScope(SCOPE, { activeOnly: true });
    expect(beliefs).toHaveLength(res.chunks);
    expect(beliefs.every((b) => b.kind === 'reference')).toBe(true);
    expect(listEvidence(SCOPE, 500)).toHaveLength(res.chunks + 1);

    // 关键：块必须出现在 context 里，而不只是能被 FTS 命中（只写证据时 context 为空）。
    const read = await readForQuery('付款条款', SCOPE, { now: Date.now() });
    expect(read.context.length).toBeGreaterThan(0);
    expect(read.facts.join('\n')).toContain('三十日内支付');
    expect(read.diagnostics.unsupportedExtraction).toBe(false);
    expect(searchBeliefs(SCOPE, '违约金').length).toBeGreaterThan(0);
  });

  it('内容未变时重复入库是 no-op', async () => {
    const scope = 'C:/ingest-same';
    const file = await makeDocx(h.userData, 'same.docx', ['稳定内容：项目代号 Atlas。']);
    const first = await ingestDocument({ filePath: file, scope });
    const again = await ingestDocument({ filePath: file, scope });

    expect(again.status).toBe('unchanged');
    expect(again.chunks).toBe(first.chunks);
    expect(getBeliefsByScope(scope, { activeOnly: true })).toHaveLength(first.chunks);
  });

  it('内容变化后重新入库：旧块被替换，旧内容不再可检索', async () => {
    const scope = 'C:/ingest-change';
    const file = path.join(h.userData, 'changing.docx');
    await writeDocument(file, { blocks: [{ type: 'paragraph', text: '旧版本：接口地址是 alpha.example.com。' }] });
    const first = await ingestDocument({ filePath: file, scope });
    expect(searchBeliefs(scope, 'alpha').length).toBeGreaterThan(0);

    await writeDocument(file, { blocks: [{ type: 'paragraph', text: '新版本：接口地址是 beta.example.com。' }] });
    const second = await ingestDocument({ filePath: file, scope });

    expect(second.status).toBe('replaced');
    expect(second.version).not.toBe(first.version);
    expect(second.superseded).toBe(first.chunks);
    // 旧块是硬删：内容必须彻底消失，而不只是被标记（被标记的旧内容仍会污染检索）。
    expect(searchBeliefs(scope, 'alpha')).toHaveLength(0);
    expect(searchBeliefs(scope, 'beta').length).toBeGreaterThan(0);
  });

  it('同一文档在两个 scope 下互不影响', async () => {
    const file = await makeDocx(h.userData, 'shared.docx', ['共享素材：图表编号 F-12。']);
    await ingestDocument({ filePath: file, scope: 'C:/scope-a' });
    await ingestDocument({ filePath: file, scope: 'C:/scope-b' });
    expect(getBeliefsByScope('C:/scope-a', { activeOnly: true }).length).toBeGreaterThan(0);
    expect(getBeliefsByScope('C:/scope-b', { activeOnly: true }).length).toBeGreaterThan(0);
    expect(searchBeliefs('C:/scope-a', 'F-12').length).toBe(1);
  });

  it('没有可索引文本的文档直接报错，而不是写一堆空块', async () => {
    const file = path.join(h.userData, 'empty.docx');
    await writeDocument(file, { blocks: [{ type: 'pageBreak' }] });
    await expect(ingestDocument({ filePath: file, scope: 'C:/empty-doc' })).rejects.toThrow(/没有可索引的文本/);
  });
});
