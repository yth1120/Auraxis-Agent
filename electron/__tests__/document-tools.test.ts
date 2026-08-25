import { describe, it, expect, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { readDocument, writeDocument } from '../document-tools';

const tmp = fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-docs-'));
const cleanup: string[] = [];

afterAll(async () => {
  for (const dir of cleanup) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function scratch(): Promise<string> {
  const dir = await tmp;
  const sub = path.join(dir, `case-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(sub, { recursive: true });
  cleanup.push(sub);
  return sub;
}

describe('document-tools', () => {
  it('writes and reads docx', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'report.docx');
    await writeDocument(file, {
      title: '测试报告',
      blocks: [
        { type: 'heading', text: '第一章', level: 1 },
        { type: 'paragraph', text: '这是段落内容 hello world' },
        {
          type: 'table',
          rows: [
            ['A', 'B'],
            ['1', '2'],
          ],
        },
      ],
    });
    const r = await readDocument(file);
    expect(r.format).toBe('docx');
    expect(r.text).toContain('这是段落内容 hello world');
    expect(r.bytes).toBeGreaterThan(0);
  });

  it('writes and reads xlsx with sheets', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'data.xlsx');
    await writeDocument(file, {
      sheets: [
        {
          name: '数据',
          rows: [
            ['列A', '列B'],
            ['1', '2'],
          ],
        },
      ],
    });
    const r = await readDocument(file);
    expect(r.format).toBe('xlsx');
    expect(r.sheets).toHaveLength(1);
    expect(r.sheets?.[0].rows[1]).toEqual(['1', '2']);
    expect(r.text).toContain('列A');
  });

  it('writes and reads pptx slides', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'deck.pptx');
    await writeDocument(file, {
      slides: [{ title: '季度汇报', bullets: ['第一点', '第二点'], notes: '讲解备注' }],
    });
    const r = await readDocument(file);
    expect(r.format).toBe('pptx');
    expect(r.text).toContain('季度汇报');
    expect(r.text).toContain('第一点');
  });

  it('writes and reads pdf', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'doc.pdf');
    await writeDocument(file, {
      title: 'PDF 标题',
      blocks: [
        { type: 'heading', text: '第一节', level: 1 },
        { type: 'paragraph', text: 'PDF content hello world 中文' },
      ],
    });
    const r = await readDocument(file);
    expect(r.format).toBe('pdf');
    expect(r.text).toContain('PDF content hello world');
    expect(r.pageCount).toBeGreaterThanOrEqual(1);
  });

  it('rejects unsupported extensions', async () => {
    const dir = await scratch();
    await expect(writeDocument(path.join(dir, 'x.txt'), { title: 'x' })).rejects.toThrow('不支持');
    await expect(readDocument(path.join(dir, 'x.txt'))).rejects.toThrow('不支持');
  });
});
