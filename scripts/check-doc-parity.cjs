/**
 * 双语 README 结构一致性检查：防止英文/中文文档标题数量与层级漂移。
 */
const fs = require('fs');
const path = require('path');

const files = ['docs/README.md', 'docs/README.zh-CN.md'];
const counts = {};

for (const rel of files) {
  const full = path.join(__dirname, '..', rel);
  const text = fs.readFileSync(full, 'utf8');
  const levels = text
    .split(/\r?\n/)
    .map((line) => /^(#{1,3}) /.exec(line)?.[1]?.length ?? 0)
    .filter(Boolean)
    .reduce((acc, level) => ((acc[level] = (acc[level] || 0) + 1), acc), { 1: 0, 2: 0, 3: 0 });
  counts[rel] = levels;
}

const [en, zh] = files;
const ok = Object.keys(counts[en]).every((level) => counts[en][level] === counts[zh][level]);
if (!ok) {
  console.error(`文档标题漂移: ${en}=${JSON.stringify(counts[en])} ${zh}=${JSON.stringify(counts[zh])}`);
  process.exit(1);
}
console.log(`文档结构一致: ${JSON.stringify(counts[en])}`);
