/**
 * document-tools.ts — professional Office / PDF document read & write.
 *
 * Supported formats:
 *   .docx — Word (mammoth read, docx writer)
 *   .xlsx — Excel (ExcelJS read / write)
 *   .pptx — PowerPoint (XML text read, PptxGenJS writer)
 *   .pdf  — PDF (pdf-parse read, PDFKit writer with CJK font fallback)
 *
 * All path/boundary checks happen in the tool layer (resolveToolPath); this
 * module only deals with file bytes and format conversion.
 */
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import {
  Document as DocxDocument,
  Packer as DocxPacker,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table as DocxTable,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  PageBreak,
} from 'docx';
import PptxGenJS from 'pptxgenjs';
import AdmZip from 'adm-zip';
import { PDFParse } from 'pdf-parse';
import PDFDocument from 'pdfkit';

/** Document extensions the document tools can read / write. */
export const DOC_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.pdf']);

export type DocumentFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf';

export interface DocumentSheet {
  name: string;
  rows: unknown[][];
}

export interface DocumentReadResult {
  format: DocumentFormat;
  fileName: string;
  bytes: number;
  text: string;
  sheets?: DocumentSheet[];
  pageCount?: number;
}

export interface DocBlock {
  type: 'paragraph' | 'heading' | 'bullet' | 'numbered' | 'table' | 'pageBreak';
  text?: string;
  level?: number;
  rows?: unknown[][];
}

export interface DocumentWriteSpec {
  title?: string;
  author?: string;
  blocks?: DocBlock[];
  sheets?: DocumentSheet[];
  slides?: {
    title?: string;
    subtitle?: string;
    bullets?: string[];
    notes?: string;
  }[];
}

function extOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Extract text runs `<a:t>…</a:t>` from a PPTX slide XML. */
function pptxSlideText(xml: string): string {
  const runs: string[] = [];
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    runs.push(decodeXmlEntities(m[1].replace(/<[^>]+>/g, '')));
  }
  return runs.join('\n').trim();
}

function pptxSlidesFromZip(buffer: Buffer): string {
  const zip = new AdmZip(buffer);
  const entries = zip
    .getEntries()
    .map((e) => ({ name: e.entryName, data: e.getData().toString('utf8') }))
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name))
    .sort((a, b) => {
      const na = Number(a.name.match(/slide(\d+)\.xml/i)?.[1] ?? 0);
      const nb = Number(b.name.match(/slide(\d+)\.xml/i)?.[1] ?? 0);
      return na - nb;
    });
  return entries.map((e, i) => `## 第 ${i + 1} 页\n${pptxSlideText(e.data)}`).join('\n\n');
}

/** Read a document file into plain text (+ structured sheets for xlsx). */
export async function readDocument(filePath: string): Promise<DocumentReadResult> {
  const resolved = path.resolve(filePath);
  const format = extOf(resolved).slice(1) as DocumentFormat;
  if (!DOC_EXTENSIONS.has(extOf(resolved))) {
    throw new Error(`不支持的文件类型: ${extOf(resolved) || '(无扩展名)'}（仅支持 .docx/.xlsx/.pptx/.pdf）`);
  }
  const bytes = (await fs.stat(resolved)).size;
  const buffer = await fs.readFile(resolved);
  const fileName = path.basename(resolved);

  switch (format) {
    case 'docx': {
      const { value } = await mammoth.extractRawText({ buffer });
      return { format, fileName, bytes, text: value.trim() };
    }
    case 'xlsx': {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      const sheets: DocumentSheet[] = workbook.worksheets.map((ws) => {
        const rows: unknown[][] = [];
        ws.eachRow({ includeEmpty: false }, (_row, rowNumber) => {
          const values: unknown[] = [];
          for (let c = 1; c <= ws.columnCount; c++) {
            values.push(ws.getCell(rowNumber, c).text);
          }
          rows.push(values);
        });
        return { name: ws.name, rows };
      });
      const text = sheets
        .map((s) => `## 工作表: ${s.name}\n${s.rows.map((r) => r.join('\t')).join('\n')}`)
        .join('\n\n');
      return { format, fileName, bytes, text, sheets };
    }
    case 'pptx': {
      const text = pptxSlidesFromZip(buffer);
      return { format, fileName, bytes, text };
    }
    case 'pdf': {
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return {
          format,
          fileName,
          bytes,
          text: (result.text || '').trim(),
          pageCount: result.total,
        };
      } finally {
        await parser.destroy().catch(() => {});
      }
    }
  }
}

function headingLevel(level?: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (level ?? 1) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 2:
      return HeadingLevel.HEADING_2;
    case 3:
      return HeadingLevel.HEADING_3;
    case 4:
      return HeadingLevel.HEADING_4;
    case 5:
      return HeadingLevel.HEADING_5;
    default:
      return HeadingLevel.HEADING_6;
  }
}

function docxBlockToParagraph(block: DocBlock): Paragraph {
  const text = block.text ?? '';
  switch (block.type) {
    case 'heading':
      return new Paragraph({ text, heading: headingLevel(block.level) });
    case 'bullet':
      return new Paragraph({
        children: [new TextRun({ text })],
        bullet: { level: Math.min(2, Math.max(0, (block.level ?? 0) - 1)) },
      });
    case 'numbered':
      return new Paragraph({
        children: [new TextRun({ text })],
        numbering: { reference: 'doc-numbering', level: Math.min(2, Math.max(0, (block.level ?? 0) - 1)) },
      });
    case 'pageBreak':
      return new Paragraph({ children: [new PageBreak()] });
    default:
      return new Paragraph({ children: [new TextRun({ text })] });
  }
}

function buildDocx(spec: DocumentWriteSpec): DocxDocument {
  const children: (Paragraph | DocxTable)[] = [];
  if (spec.title) {
    children.push(new Paragraph({ text: spec.title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }));
  }
  const blocks = spec.blocks ?? [];
  for (const block of blocks) {
    if (block.type === 'table') {
      const rows = (block.rows ?? []).map(
        (row) =>
          new TableRow({
            children: row.map(
              (cell) =>
                new TableCell({
                  width: { size: 100 / Math.max(1, row.length), type: WidthType.PERCENTAGE },
                  children: [new Paragraph({ text: String(cell ?? '') })],
                }),
            ),
          }),
      );
      children.push(
        new DocxTable({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows,
        }),
      );
      children.push(new Paragraph({ text: '' }));
      continue;
    }
    children.push(docxBlockToParagraph(block));
  }
  return new DocxDocument({
    creator: spec.author || 'Auraxis',
    title: spec.title || '',
    numbering: {
      config: [
        {
          reference: 'doc-numbering',
          levels: [0, 1, 2].map((level) => ({
            level,
            format: 'decimal',
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
          })),
        },
      ],
    },
    sections: [{ children }],
  });
}

async function buildXlsx(spec: DocumentWriteSpec): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheets =
    spec.sheets && spec.sheets.length > 0
      ? spec.sheets
      : [
          { name: 'Sheet1', rows: (spec.blocks ?? []).filter((b) => b.type === 'table').map((b) => b.rows ?? []) },
        ].filter((s) => s.rows.length > 0);
  if (sheets.length === 0) {
    throw new Error('写入 xlsx 至少需要一个非空 sheets 数组（每张表包含 rows 二维数组）');
  }
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet((sheet.name || 'Sheet').slice(0, 31));
    for (const row of sheet.rows) {
      ws.addRow(row.map((v) => (v === null || v === undefined ? '' : v)));
    }
  }
  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}

function buildPptx(spec: DocumentWriteSpec): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 });
  pptx.layout = 'WIDE';
  const slides =
    spec.slides && spec.slides.length > 0
      ? spec.slides
      : spec.title
        ? [{ title: spec.title, bullets: (spec.blocks ?? []).filter((b) => b.text).map((b) => b.text as string) }]
        : [];
  if (slides.length === 0) {
    throw new Error('写入 pptx 至少需要一个 slides 数组（每项含 title 或 bullets）');
  }
  for (const slideDef of slides) {
    const slide = pptx.addSlide();
    if (slideDef.title) {
      slide.addText(slideDef.title, {
        x: 0.6,
        y: 0.45,
        w: 12.1,
        h: 0.9,
        fontSize: 28,
        bold: true,
        color: '111216',
      });
    }
    if (slideDef.subtitle) {
      slide.addText(slideDef.subtitle, {
        x: 0.6,
        y: 1.3,
        w: 12.1,
        h: 0.6,
        fontSize: 16,
        color: '8C8AA8',
      });
    }
    const bullets = slideDef.bullets ?? [];
    if (bullets.length > 0) {
      slide.addText(
        bullets.map((b) => ({ text: b, options: { bullet: { code: '2022' }, breakLine: true } })),
        { x: 0.6, y: 2.0, w: 12.1, h: 4.6, fontSize: 18, color: '111216', valign: 'top' },
      );
    }
    if (slideDef.notes) {
      slide.addNotes(slideDef.notes);
    }
  }
  return pptx.write({ outputType: 'nodebuffer' }) as unknown as Promise<Buffer>;
}

interface CjkFont {
  path: string;
  family?: string;
}

/** Candidate CJK fonts by platform — PDFKit falls back to built-in fonts. */
function pickCjkFont(): CjkFont | null {
  const candidates: CjkFont[] = [];
  if (process.platform === 'win32') {
    candidates.push(
      { path: 'C:\\Windows\\Fonts\\msyh.ttc', family: 'MicrosoftYaHei' },
      { path: 'C:\\Windows\\Fonts\\simhei.ttf', family: 'SimHei' },
      { path: 'C:\\Windows\\Fonts\\simsun.ttc', family: 'SimSun' },
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      { path: '/System/Library/Fonts/PingFang.ttc', family: 'PingFang SC' },
      { path: '/System/Library/Fonts/STHeiti Light.ttc', family: 'STHeitiSC-Light' },
    );
  } else {
    candidates.push(
      { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK SC' },
      { path: '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', family: 'WenQuanYi Micro Hei' },
    );
  }
  return candidates.find((c) => existsSync(c.path)) ?? null;
}

function pdfBlockToLines(block: DocBlock): Array<{ text: string; size: number; bold: boolean }> {
  const text = block.text ?? '';
  switch (block.type) {
    case 'heading':
      return [{ text, size: Math.max(14, 26 - ((block.level ?? 1) - 1) * 3), bold: true }];
    case 'pageBreak':
      return [{ text: '\f', size: 12, bold: false }];
    default:
      return [{ text, size: 12, bold: false }];
  }
}

/** Write a document. PDF uses PDFKit with a CJK-capable system font when available. */
export async function writeDocument(
  filePath: string,
  spec: DocumentWriteSpec,
): Promise<{ format: DocumentFormat; bytes: number }> {
  const resolved = path.resolve(filePath);
  const format = extOf(resolved).slice(1) as DocumentFormat;
  if (!DOC_EXTENSIONS.has(extOf(resolved))) {
    throw new Error(
      `不支持的目标类型：写入目标必须是文档文件（.docx/.xlsx/.pptx/.pdf），收到: ${extOf(resolved) || '(无扩展名)'}`,
    );
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });

  let buffer: Buffer;
  switch (format) {
    case 'docx': {
      const doc = buildDocx(spec);
      buffer = await DocxPacker.toBuffer(doc);
      break;
    }
    case 'xlsx':
      buffer = await buildXlsx(spec);
      break;
    case 'pptx':
      buffer = await buildPptx(spec);
      break;
    case 'pdf':
      buffer = await buildPdf(spec);
      break;
  }
  await fs.writeFile(resolved, buffer);
  return { format, bytes: buffer.byteLength };
}

function buildPdf(spec: DocumentWriteSpec): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cjkFont = pickCjkFont();
    const doc = new PDFDocument({
      size: 'A4',
      margin: 48,
      info: { Title: spec.title || '', Author: spec.author || 'Auraxis' },
      bufferPages: true,
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const useCjk = !!cjkFont;
    if (useCjk) {
      try {
        doc.font(cjkFont!.path, cjkFont!.family!);
      } catch {
        doc.font('Helvetica');
      }
    }

    if (spec.title) {
      doc.fontSize(24).text(spec.title, { align: 'center' });
      doc.moveDown(0.8);
    }
    const blocks = spec.blocks ?? [];
    for (const block of blocks) {
      const lines = pdfBlockToLines(block);
      for (const line of lines) {
        if (line.text === '\f') {
          doc.addPage();
          continue;
        }
        if (line.bold) {
          if (useCjk) doc.font(cjkFont!.path, cjkFont!.family!);
          else doc.font('Helvetica-Bold');
        } else if (useCjk) {
          doc.font(cjkFont!.path, cjkFont!.family!);
        } else {
          doc.font('Helvetica');
        }
        doc.fontSize(line.size).text(line.text, {
          lineGap: 2,
          paragraphGap: 2,
        });
      }
    }
    doc.end();
  });
}
