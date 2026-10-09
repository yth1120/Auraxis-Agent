// 验收脚本：改动后用 `node check.mjs` 自检（退出码 0 = 通过）。
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/config.ts', import.meta.url), 'utf8');
const match = /apiTimeoutMs\s*=\s*(\d+)/.exec(source);
if (!match) {
  console.error('config.ts 里找不到 apiTimeoutMs');
  process.exit(1);
}
if (Number(match[1]) !== 60000) {
  console.error(`apiTimeoutMs 期望 60000，实际 ${match[1]}`);
  process.exit(1);
}
console.log('check ok');
