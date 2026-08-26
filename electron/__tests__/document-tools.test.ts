import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { readDocument, writeDocument } from '../document-tools';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-doc-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('document-tools — real file round trips', () => {
  it('writes and reads docx with headings, bullets, tables and page breaks', async () => {
    const file = path.join(root, 'demo.docx');
    const written = await writeDocument(file, {
      title: 'Auraxis',
      author: 'Test',
      blocks: [
        { type: 'heading', text: 'Heading', level: 3 },
        { type: 'bullet', text: 'bullet' },
        { type: 'numbered', text: 'number', level: 2 },
        { type: 'table', rows: [['a', 'b']] },
        { type: 'pageBreak' },
        { type: 'paragraph', text: 'last' },
      ],
    });
    expect(written).toMatchObject({ format: 'docx' });
    const read = await readDocument(file);
    expect(read.format).toBe('docx');
    expect(read.text).toContain('Heading');
    expect(read.bytes).toBeGreaterThan(0);
  });

  it('writes and reads xlsx sheets and rejects empty sheets', async () => {
    const file = path.join(root, 'demo.xlsx');
    await writeDocument(file, {
      sheets: [
        {
          name: 'Sheet1',
          rows: [
            ['a', 'b'],
            ['c', 'd'],
          ],
        },
      ],
    });
    const read = await readDocument(file);
    expect(read.sheets?.[0].rows).toHaveLength(2);
    await expect(writeDocument(path.join(root, 'empty.xlsx'), { sheets: [] })).rejects.toThrow('至少需要一个');
  });

  it('writes and reads pptx slides', async () => {
    const file = path.join(root, 'demo.pptx');
    await writeDocument(file, {
      slides: [{ title: 'Title', subtitle: 'Sub', bullets: ['one', 'two'], notes: 'note' }],
    });
    const read = await readDocument(file);
    expect(read.format).toBe('pptx');
    expect(read.text).toContain('Title');
    await expect(writeDocument(path.join(root, 'empty.pptx'), {})).rejects.toThrow('至少需要一个 slides');
  });

  it('writes and reads pdf with headings, paragraphs and page breaks', async () => {
    const file = path.join(root, 'demo.pdf');
    await writeDocument(file, {
      title: 'PDF',
      blocks: [
        { type: 'heading', text: 'A heading', level: 2 },
        { type: 'paragraph', text: 'body text' },
        { type: 'pageBreak' },
      ],
    });
    const read = await readDocument(file);
    expect(read.format).toBe('pdf');
    expect(read.text).toContain('A heading');
    expect(read.pageCount).toBeGreaterThan(0);
  });

  it('rejects unsupported extensions on read and write', async () => {
    const file = path.join(root, 'demo.txt');
    await fs.writeFile(file, 'x', 'utf8');
    await expect(readDocument(file)).rejects.toThrow('不支持的文件类型');
    await expect(writeDocument(file, {})).rejects.toThrow('不支持的目标类型');
  });

  it('covers document spec fallbacks, heading levels and null cells', async () => {
    const docx2 = path.join(root, 'fallback.docx');
    await writeDocument(docx2, {
      blocks: [
        { type: 'heading', text: 'H1', level: 1 },
        { type: 'heading', text: 'H2', level: 2 },
        { type: 'heading', text: 'H4', level: 4 },
        { type: 'heading', text: 'H5', level: 5 },
        { type: 'heading', text: 'H6', level: 6 },
        { type: 'table', rows: [[null, undefined, 'x' as never]] },
        { type: 'paragraph', text: 'plain' },
      ],
    });
    expect(await readDocument(docx2)).toMatchObject({ format: 'docx' });

    const xlsx2 = path.join(root, 'fallback.xlsx');
    await writeDocument(xlsx2, {
      blocks: [
        { type: 'table', rows: [['a'], [null, 'b' as never]] },
      ],
    });
    expect((await readDocument(xlsx2)).sheets?.[0]?.rows).toHaveLength(1);

    const pptx2 = path.join(root, 'fallback.pptx');
    await writeDocument(pptx2, {
      title: 'Title only',
      blocks: [{ type: 'bullet', text: 'bullet' }],
    });
    expect(await readDocument(pptx2)).toMatchObject({ format: 'pptx' });

    const pptx3 = path.join(root, 'minimal.pptx');
    await writeDocument(pptx3, { slides: [{ title: 'Slide' }] });
    expect(await readDocument(pptx3)).toMatchObject({ format: 'pptx' });

    const pdf2 = path.join(root, 'fallback.pdf');
    await writeDocument(pdf2, {
      blocks: [
        { type: 'heading', text: 'heading', level: 5 },
        { type: 'paragraph', text: 'body' },
      ],
    });
    expect(await readDocument(pdf2)).toMatchObject({ format: 'pdf' });

    const noExt = path.join(root, 'no-extension');
    await fs.writeFile(noExt, 'x', 'utf8');
    await expect(readDocument(noExt)).rejects.toThrow('无扩展名');
    await expect(writeDocument(noExt, {})).rejects.toThrow('无扩展名');
  });
});
