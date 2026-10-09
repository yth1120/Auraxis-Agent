/**
 * annotation.ts — 页面标注的渲染（纯函数）。
 *
 * 一份标注有两个读者，**必须由同一段文字供两者**，否则"用户看到的"和"模型看到的"会漂移：
 *   · 模型 —— `chatSendMessage` 把它拼进发给模型的内容；
 *   · 用户 —— 用户消息上的标注摘要，以及执行视图里的 `browser_annotation` 项。
 */
import type { BrowserAnnotation } from '../../../electron/contracts/browser';

/** 元素的人类可读名字：优先用元素文本，其次标签名，最后选择器。 */
export function annotationLabel(annotation: BrowserAnnotation): string {
  const text = (annotation.elementText ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return annotation.tag || annotation.selector;
}

/**
 * 渲染成给模型看的一段文本。
 *
 * 刻意写明"这是用户在页面上手动标注的"：模型必须知道这些不是它自己观测到的，
 * 而是用户指给它的东西 —— 否则它会把标注当成页面全文来推断。
 */
export function renderAnnotationBlock(annotations: readonly BrowserAnnotation[]): string {
  if (annotations.length === 0) return '';
  const lines = annotations.map((a) => {
    const where = a.selector ? ` （选择器 ${a.selector}）` : '';
    return `- 页面 ${a.url}${a.title ? `（${a.title}）` : ''} 的元素「${annotationLabel(a)}」${where}：${a.comment}`;
  });
  return `<user_page_annotations>\n用户在预览页面上手动标注了以下内容，请把它们当作明确的用户输入：\n${lines.join('\n')}\n</user_page_annotations>`;
}
