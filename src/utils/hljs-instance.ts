// Centralized highlight.js singleton — both DiffView (per-line highlighting)
// and CodeBlock (full-block highlighting) hit the same registered languages.
// Module-level side-effect registers once; subsequent imports are no-ops.
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('scss', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'css',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  rs: 'rust',
  go: 'go',
  java: 'java',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
};

/** Best-effort: derive a hljs language id from a filename or path. */
export function getLangFromFilename(name?: string): string | undefined {
  if (!name) return undefined;
  const base = name.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext];
}

export { hljs };
