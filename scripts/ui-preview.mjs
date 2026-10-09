/**
 * ui-preview.mjs — 在**纯浏览器**里把执行视图打开并截图（一次性开发工具，不进 CI）。
 *
 * 为什么需要它：本机起不了真实 Electron 窗口（`npm run test:e2e` / `test:smoke` 都死在
 * `Process failed to launch!`），而"只读代码猜 UI"恰恰是这一轮改造要避免的事。这里用
 * 已有的 playwright 依赖 + 系统 Chrome（**不下载浏览器**）起 Vite 开发服务，注入一份
 * 覆盖各种 Activity 形态的会话数据，逐屏截图给人看。
 *
 * 用法：
 *   npm run dev               # 另开一个终端，Vite 在 5173
 *   node scripts/ui-preview.mjs [输出目录]
 *
 * **它不是 e2e**：没有真实 Electron 环境（`window.electronAPI` 是下面这个桩），
 * 验不了 IPC、字体渲染、玻璃与窗口行为 —— 只看渲染、布局、层级与交互。
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(process.argv[2] ?? 'screenshots');
const URL = process.env.PREVIEW_URL ?? 'http://localhost:5173';
/** 主题：`light`（默认）/ `dark`。走 `useAppStore` 的 persist 字段，由 `useThemeClass` 切 `html.dark`。 */
const THEME = process.env.PREVIEW_THEME === 'dark' ? 'dark' : 'light';
/** 要拍的屏。默认只拍聊天区（原有行为）。 */
const SCREEN = process.env.PREVIEW_SCREEN ?? 'chat';
/**
 * 认证相位：`unlocked`（默认，直接进工作台）/ `setup`（首次启动注册页）/ `locked`（登录页）。
 * 由 `auth.status` 的桩返回，AuthGate 据此分流。
 */
const AUTH = process.env.PREVIEW_AUTH ?? 'unlocked';

/** 一条覆盖各种 Activity 形态的会话（顺序刻意安排：读取聚合 → 检索聚合 → 改动 → 计划 → 终端 → 权限）。 */
function seedMessages(now) {
  const tc = (over) => ({
    requestId: 'req-1',
    toolName: 'Read',
    input: { file_path: 'src/a.ts' },
    status: 'done',
    startTime: now - 60_000,
    endTime: now - 59_000,
    durationMs: 900,
    ...over,
  });

  const reads = ['service', 'controller', 'types', 'middleware'].map((name, i) =>
    tc({
      id: `read-${i}`,
      toolName: 'Read',
      input: { file_path: `src/auth/${name}.ts` },
      output: { file_path: `src/auth/${name}.ts`, content: `export const ${name} = 1;\n`, total_lines: 42 },
      ...(i === 3 ? { summary: { lines: 42, size: 2048 } } : {}),
    }),
  );

  const greps = [8, 4, 2].map((n, i) =>
    tc({
      id: `grep-${i}`,
      toolName: 'Grep',
      input: { pattern: 'verifyToken' },
      output: { results: [], match_count: n },
      summary: { matchCount: n },
    }),
  );

  const edit = tc({
    id: 'edit-1',
    toolName: 'Edit',
    input: { file_path: 'src/auth/service.ts' },
    output: { file_path: 'src/auth/service.ts', oldContent: 'const a = 1;', newContent: 'const a = 2;\nconst b = 3;' },
    oldContent: 'const a = 1;',
    newContent: 'const a = 2;\nconst b = 3;',
  });

  const todo = tc({
    id: 'todo-1',
    toolName: 'TodoWrite',
    input: {
      todos: [
        { content: '读认证相关代码', status: 'completed' },
        { content: '改中间件校验', status: 'completed' },
        { content: '补单元测试', status: 'in_progress' },
        { content: '跑一遍全量验证', status: 'pending' },
      ],
    },
    status: 'running',
    endTime: undefined,
  });

  const tests = tc({
    id: 'test-1',
    toolName: 'Bash',
    input: { command: 'npm test' },
    output: { stdout: 'PASS 14 tests', stderr: '', exitCode: 0 },
    summary: { exitCode: 0, stdoutLen: 1200, stderrLen: 0 },
  });

  const live = tc({
    id: 'live-1',
    toolName: 'Bash',
    input: { command: 'npm run build', workdir: 'C:/proj' },
    status: 'running',
    endTime: undefined,
    streamOutput: Array.from(
      { length: 60 },
      (_, i) => `\u001b[32m✓\u001b[0m building chunk ${i + 1}/60 … ${i * 137}ms`,
    ).join('\n'),
  });

  const failed = tc({
    id: 'fail-1',
    toolName: 'Bash',
    input: { command: 'npm run lint' },
    status: 'error',
    error: "error TS2322: Type 'string' is not assignable to type 'number'",
    output: { stdout: '', stderr: 'error TS2322', exitCode: 2 },
    summary: { exitCode: 2, stdoutLen: 0, stderrLen: 16 },
  });

  const subAgent = tc({
    id: 'agent-1',
    toolName: 'Agent',
    input: { description: '调研认证中间件的调用链', _agentId: 'sub-1' },
    output: { summary: '完成', steps: 4 },
    status: 'running',
    endTime: undefined,
  });

  return [
    { id: 'user-1', role: 'user', content: '帮我修复登录问题。', timestamp: now - 70_000 },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: now - 60_000,
      isStreaming: true,
      toolCalls: [...reads, ...greps, edit, todo, subAgent, tests, live, failed],
    },
    {
      id: 'perm-msg-1',
      role: 'system',
      content: '',
      timestamp: now - 5_000,
      permissionRequest: {
        requestId: 'perm-1',
        toolName: 'Bash',
        input: { command: 'npm install --save jsonwebtoken' },
        message: '需要安装依赖',
        timestamp: now - 5_000,
        mode: 'ask',
      },
    },
  ];
}

/** 长任务场景：已结束、40 段（超过折叠门槛），用来看"已完成"排版与历史折叠。 */
function longRunMessages(now) {
  const edits = Array.from({ length: 30 }, (_, i) => ({
    requestId: 'req-long',
    id: `edit-${i}`,
    toolName: 'Edit',
    input: { file_path: `src/module-${i}/index.ts` },
    output: { file_path: `src/module-${i}/index.ts`, oldContent: 'a', newContent: 'a\nb' },
    status: 'done',
    startTime: now - 60_000 + i * 1000,
    endTime: now - 59_000 + i * 1000,
    durationMs: 800,
  }));
  const reads = Array.from({ length: 5 }, (_, i) => ({
    requestId: 'req-long',
    id: `read-${i}`,
    toolName: 'Read',
    input: { file_path: `src/deep/nested/area/file-${i}.ts` },
    output: { file_path: `src/deep/nested/area/file-${i}.ts`, content: 'x' },
    status: 'done',
    startTime: now - 90_000 + i * 100,
    endTime: now - 89_000 + i * 100,
    durationMs: 500,
  }));
  return [
    { id: 'user-2', role: 'user', content: '重构整个模块目录。', timestamp: now - 120_000 },
    {
      id: 'assistant-2',
      role: 'assistant',
      content: '## 重构完成\n\n把 30 个模块拆成了独立目录，统一了导出口径。',
      timestamp: now - 100_000,
      isStreaming: false,
      toolCalls: [...reads, ...edits],
    },
  ];
}

/** 点可见文字到达某屏。点不到就**如实报告**——静默跳过会拍出一张"看起来没问题"的错屏。 */
async function clickText(page, text, wait = 600) {
  const byRole = page.getByRole('button', { name: text, exact: false }).first();
  const target = (await byRole.count()) ? byRole : page.getByText(text, { exact: false }).first();
  if (!(await target.count())) {
    console.warn(`  ⚠ 找不到「${text}」——这一屏可能没到达`);
    return false;
  }
  await target.click({ timeout: 8000 }).catch(async () => target.click({ force: true }));
  await page.waitForTimeout(wait);
  return true;
}

/**
 * 在**右栏内**点某一行。
 *
 * 不能用全局 `clickText`：右栏的功能名与顶栏菜单重名（「文件」既是右栏的功能、
 * 也是顶栏的菜单），`getByRole(...).first()` 会点到菜单上、把下拉打开。
 */
async function clickInRightPanel(page, text) {
  const target = page.locator('aside[data-pane="right"]').getByText(text, { exact: false }).first();
  if (!(await target.count())) {
    console.warn(`  ⚠ 右栏里找不到「${text}」`);
    return false;
  }
  await target.click();
  await page.waitForTimeout(600);
  return true;
}

async function openSettings(page) {
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(900);
}

/**
 * 逐屏导航。布局类（模式/左栏/右栏/主题）已由 seed 决定，这里只处理
 * 不在 `partialize` 里、只能靠交互到达的（设置面板、命令面板）。
 */
function makeScreens(page) {
  return {
    chat: async () => {},
    /** 只按 seed 的布局拍一张（配合 PREVIEW_MODE / PREVIEW_LEFT / PREVIEW_RIGHT 用）。 */
    layout: async () => {},
    palette: async () => {
      await page.keyboard.press('Control+k');
      await page.waitForTimeout(700);
    },
    settings: () => openSettings(page),
    /** 集成终端（Ctrl+`）。需 PREVIEW_MODE=work|code —— Chat 模式没有终端面。 */
    terminal: async () => {
      await page.keyboard.press('Control+Backquote');
      await page.waitForTimeout(800);
    },
    /** 连点两次「新建终端」——验证 `+` 是**新建会话**而不是刷新当前视图。 */
    'terminal-multi': async () => {
      await page.keyboard.press('Control+Backquote');
      await page.waitForTimeout(800);
      const plus = page.getByRole('button', { name: '新建终端' }).first();
      await plus.click();
      await page.waitForTimeout(400);
      await plus.click();
      await page.waitForTimeout(500);
    },
    /** 打开右侧工作台面板（`showRightPanel` 不持久化，只能点）。需 PREVIEW_MODE=work|code。 */
    'right-panel': async () => {
      await clickText(page, '工作台面板');
      await page.waitForTimeout(500);
    },
    /** 右栏：概览（只读摘要）。验证这里**没有**操作按钮、也**不再重复** token 总量。 */
    'right-panel-summary': async () => {
      await clickText(page, '工作台面板');
      await page.waitForTimeout(500);
      await clickInRightPanel(page, '概览');
      await page.waitForTimeout(600);
    },
    /** 右栏：计划。验证这里**只有**清单，不再把 goal 文本再抄一遍（那是 GoalBar 的事）。 */
    'right-panel-plan': async () => {
      await clickText(page, '工作台面板');
      await page.waitForTimeout(500);
      await clickInRightPanel(page, '计划');
      await page.waitForTimeout(600);
    },
    /** 右栏：进入某个模块的详情（看详情头里的 `+`）。 */
    'right-panel-detail': async () => {
      await clickText(page, '工作台面板');
      await page.waitForTimeout(500);
      await clickInRightPanel(page, '变更');
      await page.waitForTimeout(600);
    },
    /** 右栏：进入「文件」模块（看模块自己的 `+`，需 PREVIEW_PROJECT=1）。 */
    'right-panel-files': async () => {
      await clickText(page, '工作台面板');
      await page.waitForTimeout(500);
      await clickInRightPanel(page, '文件');
      await page.waitForTimeout(700);
    },
    /** 右栏全屏。 */
    'right-panel-fullscreen': async () => {
      await clickText(page, '工作台面板');
      await page.waitForTimeout(400);
      await clickText(page, '全屏');
    },
    'settings-memory': async () => {
      await openSettings(page);
      await clickText(page, '记忆');
    },
    'settings-mcp': async () => {
      await openSettings(page);
      await clickText(page, 'MCP');
    },
    'settings-keybindings': async () => {
      await openSettings(page);
      await clickText(page, '快捷键');
    },
    'settings-coverage': async () => {
      await openSettings(page);
      await clickText(page, '测试覆盖率');
    },
  };
}

/** 参考实现里那些"写了但产物中不存在"的类名 —— 判据是产物 CSS，不是这里。 */
const DEAD_CLASSES = [
  'text-muted',
  'text-faint',
  'text-secondary',
  'border-dim',
  'bg-secondary',
  'bg-tertiary',
  'bg-elevated',
  'bg-inset',
  'text-on-accent',
  'duration-fast',
  'duration-normal',
];

/**
 * 死类探针：把 DOM 里**真正带着死类**的元素捞出来，读它们的计算样式。
 *
 * 为什么需要它：死类的表现是"属性回落到继承/初始值"，肉眼在浅色下很难分辨
 * （`text-muted` 失效后用的是正文色 #111216，而不是 #454b53）。
 * 机械读取才能在改前说清损伤、改后证明归零。
 */
async function probeDeadClasses(page) {
  const rows = await page.evaluate((dead) => {
    const base = (t) => t.replace(/^.*:/, '').replace(/\/.*$/, '');
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
      if (!cls) continue;
      const hits = cls.split(/\s+/).filter((t) => dead.includes(base(t)));
      if (!hits.length) continue;
      const cs = getComputedStyle(el);
      out.push({
        hits: [...new Set(hits)],
        tag: el.tagName.toLowerCase(),
        color: cs.color,
        bg: cs.backgroundColor,
        border: cs.borderTopColor + ' ' + cs.borderTopWidth,
        text: (el.textContent || '').trim().slice(0, 26),
      });
    }
    return out;
  }, DEAD_CLASSES);

  const byToken = new Map();
  for (const r of rows) for (const h of r.hits) byToken.set(h, (byToken.get(h) ?? 0) + 1);
  console.log(`\n[死类探针] ${SCREEN}/${THEME} — 命中 ${rows.length} 个元素`);
  for (const [t, n] of [...byToken].sort((a, b) => b[1] - a[1])) console.log(`   ${t.padEnd(16)} ${n}`);
  if (process.env.PREVIEW_PROBE_DETAIL) {
    for (const r of rows) {
      console.log(`   · ${r.hits.join(',')} <${r.tag}> color=${r.color} bg=${r.bg} border=${r.border}  "${r.text}"`);
    }
  }
  return rows.length;
}

/**
 * 定点查计算样式：`PREVIEW_INSPECT=".ant-modal-close,.ant-select"`。
 * 用于核验"覆盖到底有没有生效" —— 光看选择器改对了不够，要看浏览器算出来的值。
 */
async function inspectStyles(page, spec) {
  const keys = [
    'color',
    'backgroundColor',
    'border',
    'borderRadius',
    'boxShadow',
    'outline',
    'padding',
    'fontSize',
    // 动画：keyframes 名字写错会**静默**退化成静态，必须能查到才算验过。
    'animationName',
    'animationDuration',
    'animationPlayState',
  ];
  for (const sel of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    // `var:--x` → 读根元素上该变量的**解析后**取值。用于验证令牌真的定义了
    // （未定义时这里会是空串，而用在 `var()` 里会静默回落到 initial）。
    if (sel.startsWith('var:')) {
      const name = sel.slice(4);
      const value = await page.evaluate(
        (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
        name,
      );
      console.log(`\n[变量] ${name} = ${value || '（未定义！）'}`);
      continue;
    }
    // `markup:<html>` → 把一段标记挂进真实页面、读它的**计算样式**再移除。
    // 用于验证"类名 → CSS"的契约本身（例如崩溃页那种只有抛错才会出现的画面，
    // 无法靠导航到达，但它的样式契约可以在真实样式表下直接测）。
    if (sel.startsWith('markup:')) {
      const html = sel.slice(7);
      const found = await page.evaluate(
        ({ h, k }) => {
          const host = document.createElement('div');
          host.innerHTML = h;
          document.body.appendChild(host);
          const el = host.firstElementChild;
          if (!el) return null;
          const cs = getComputedStyle(el);
          const out = Object.fromEntries(k.map((name) => [name, cs[name]]));
          host.remove();
          return out;
        },
        { h: html, k: keys },
      );
      console.log(`\n[注入] ${html.slice(0, 70)}${html.length > 70 ? '…' : ''}`);
      if (!found) console.log('   （标记里没有元素）');
      else for (const [k, v] of Object.entries(found)) console.log(`   ${k.padEnd(15)} ${v}`);
      continue;
    }
    const found = await page.evaluate(
      ({ s, k }) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const parent = el.parentElement?.getBoundingClientRect();
        return {
          ...Object.fromEntries(k.map((name) => [name, cs[name]])),
          // 几何：判断"元素有没有被挤出可视区"必须看坐标 —— 溢出的元素计算样式
          // 一切正常，只是 x 落在容器之外（上一轮发送键消失就是这么发生的）。
          '→ width': Math.round(rect.width),
          '→ left': Math.round(rect.left),
          '→ right': Math.round(rect.right),
          '→ 父右边界': parent ? Math.round(parent.right) : null,
          '→ 溢出': el.scrollWidth > el.clientWidth + 1 ? `是 (${el.scrollWidth}>${el.clientWidth})` : '否',
        };
      },
      { s: sel, k: keys },
    );
    console.log(`\n[样式] ${sel}`);
    if (!found) console.log('   （页面上找不到这个元素）');
    else for (const [k, v] of Object.entries(found)) console.log(`   ${k.padEnd(15)} ${v}`);
  }
}

/**
 * 换行探针：找出**主区里哪些文本元素真的占了两行以上**。
 *
 * 判据不是"高度大"（那会把多行正文也算进来），而是用 Range 量出**同一个文本节点
 * 被排成了几个行盒**。只报短文本（≤ 40 字）的多行 —— 长段落换行是正常的，
 * 短标签被挤到换行才是"窄容器下不自适应"。
 */
async function probeWrapping(page) {
  const rows = await page.evaluate(() => {
    const root = document.querySelector('[data-pane="main"]') || document.body;
    const out = [];
    for (const el of root.querySelectorAll('*')) {
      // 只看"叶子文本"元素，避免父元素把整棵子树的行数算进来
      const text = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n);
      if (!text.length) continue;
      const cs = getComputedStyle(el);
      if (!cs.whiteSpace.startsWith('normal') || cs.display === 'none') continue;
      const full = text.map((n) => n.textContent.trim()).join(' ');
      if (full.length === 0 || full.length > 40) continue;
      // 行数 = **不同的行顶坐标**个数。不能把各文本节点的 rect 数相加：
      // 同一个元素里的 "113" 与 "s" 是两个文本节点、却在同一行，会把 1 行算成 2 行。
      const tops = new Set();
      for (const node of text) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) tops.add(Math.round(r.top));
      }
      const lines = tops.size;
      if (lines > 1) {
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
          lines,
          text: full.slice(0, 30),
          w: Math.round(el.getBoundingClientRect().width),
        });
      }
    }
    return out;
  });
  console.log(`\n[换行探针] ${SCREEN}/${THEME} — 主区里被挤到多行的短文本 ${rows.length} 处`);
  for (const r of rows) console.log(`   ${r.lines} 行 / 宽${r.w}px  <${r.tag}> "${r.text}"  .${r.cls}`);
  return rows.length;
}

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  // `PREVIEW_VIEWPORT="1400x900"` —— 主区能有多宽最终由窗口决定，
  // 用它复现"窗口不够宽时内容被挤"的情况。
  const [vpW, vpH] = (process.env.PREVIEW_VIEWPORT ?? '1280x900').split('x').map(Number);
  const context = await browser.newContext({
    viewport: { width: vpW, height: vpH },
    // `PREVIEW_REDUCED_MOTION=1` —— 模拟系统「减少动态效果」。
    // 位图 GIF 不受它影响（旧 `executing.gif` 就是全应用唯一关不掉的持续动画），
    // CSS 动画才受控，所以这条路必须能实测。
    ...(process.env.PREVIEW_REDUCED_MOTION ? { reducedMotion: 'reduce' } : {}),
  });

  await context.addInitScript(
    ({ messages: seed, theme, layout, project, auth }) => {
      /**
       * `window.electronAPI` 的桩。三条约束都是踩出来的：
       *  - `auth.status` 必须返回 `unlocked`，否则 AuthGate 停在注册页；
       *  - `homePath` 必须是**空串**（有代码对它 `.replace`，给函数会抛 TypeError）；
       *  - 未声明的属性要同时**可调用**又**可继续取属性**（`cron.list(...)`、
       *    `onXxx(cb)` 返回退订函数），并且 `.ok` 为假 —— 否则渲染期就抛错，页面白屏。
       */
      const make = () =>
        new Proxy(function () {}, {
          get: (_t, key) => {
            if (key === 'then') return (res, rej) => Promise.resolve({ ok: false }).then(res, rej);
            if (key === 'ok') return false;
            if (key === 'data' || key === 'error') return undefined;
            return make();
          },
          apply: () => make(),
          has: () => true,
        });
      window.electronAPI = new Proxy(
        {
          homePath: '',
          platform: 'win32',
          versions: {},
          auth: {
            status: async () => ({
              ok: true,
              data: { phase: auth, name: auth === 'locked' ? 'Preview' : '', email: 'preview@local' },
            }),
          },
          isMaximized: async () => false,
          onMaximizeChange: () => () => {},
        },
        { get: (t, k) => (k in t ? t[k] : make()), has: () => true },
      );
      window.localStorage.setItem('auraxis-chat-storage', JSON.stringify({ state: { messages: seed }, version: 2 }));
      // `PREVIEW_PROJECT=1` —— 打开一个假的项目根目录。
      // 有些 UI 只在"已开项目"时才出现（例如右栏文件模块的「新建文件」`+`）。
      if (project) {
        window.localStorage.setItem(
          'auraxis-settings-storage',
          JSON.stringify({ state: { projectPath: 'C:/preview-project' }, version: 2 }),
        );
      }
      // 布局类状态**在 partialize 里**，所以能直接 seed 到目标屏：
      // `sidebarMode` / `activeLeftPanel` / `rightPanelView` / `theme`。
      // （`activeToolView` / `showSettings` / `showRightPanel` 不在，只能点击到达。）
      window.localStorage.setItem(
        'auraxis-app-storage',
        JSON.stringify({
          state: {
            theme,
            sidebarMode: layout.sidebarMode,
            activeLeftPanel: layout.activeLeftPanel,
            rightPanelView: layout.rightPanelView,
            rightPanelWidth: layout.rightPanelWidth,
          },
          version: 3,
        }),
      );
    },
    {
      messages: process.env.PREVIEW_SCENARIO === 'long' ? longRunMessages(Date.now()) : seedMessages(Date.now()),
      theme: THEME,
      project: Boolean(process.env.PREVIEW_PROJECT),
      auth: AUTH,
      layout: {
        sidebarMode: process.env.PREVIEW_MODE ?? 'chat',
        activeLeftPanel: process.env.PREVIEW_LEFT ?? 'files',
        rightPanelView: process.env.PREVIEW_RIGHT ?? 'menu',
        // 右栏宽度是持久化字段 —— 用它复现"在宽窗口调好、换到窄窗口后中间被挤压"。
        rightPanelWidth: Number(process.env.PREVIEW_RIGHT_WIDTH ?? 320),
      },
    },
  );

  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('requestfailed', (req) => console.warn('  ✗', req.url().slice(0, 120), req.failure()?.errorText));
  // `commit` 而不是 `domcontentloaded`：Vite 首屏要现编译几百个模块，首次加载经常 >30s，
  // 等 DOM 事件会误判成"起不来"。改为先 commit，再按选择器耐心等应用挂载。
  await page.goto(URL, { waitUntil: 'commit', timeout: 60_000 });
  // 认证相位下工作台在闸门后面，输入框**永远不会**出现 —— 等它就等于必然超时。
  await page.waitForSelector(AUTH === 'unlocked' ? '.ax-composer-textarea' : '.ax-auth-card', { timeout: 240_000 });
  await page.waitForTimeout(1500); // 等 Virtuoso 测量与懒渲染

  const shot = async (name, opts = {}) => {
    await page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
    console.log('✓', `${name}.png`);
  };

  const SCREENS = makeScreens(page);

  // `PREVIEW_STYLE=".chat-input{display:none}"` —— 注入临时 CSS，
  // 用于把遮挡物（浮动输入框等）让开，拍到被挡住的整块区域。
  if (process.env.PREVIEW_STYLE) {
    await page.addStyleTag({ content: process.env.PREVIEW_STYLE });
    await page.waitForTimeout(200);
  }

  if (SCREEN !== 'chat') {
    const run = SCREENS[SCREEN];
    if (!run) throw new Error(`未知的 PREVIEW_SCREEN: ${SCREEN}（可选：${Object.keys(SCREENS).join(' / ')}）`);
    await run();

    if (process.env.PREVIEW_INSPECT) await inspectStyles(page, process.env.PREVIEW_INSPECT);
    if (process.env.PREVIEW_WRAP_PROBE) await probeWrapping(page);
    await probeDeadClasses(page);

    // `PREVIEW_INJECT="<div>…</div>"` —— 把一段标记盖在应用上再截图，
    // 用于在**真实样式表与真实主题变量**下看一个组件的样子（本次是运行标记样张）。
    if (process.env.PREVIEW_INJECT) {
      await page.evaluate((html) => {
        const host = document.createElement('div');
        host.innerHTML = html;
        host.style.cssText =
          'position:fixed;inset:0;z-index:99999;background:var(--color-bg-primary);color:var(--color-text-primary);padding:32px;overflow:auto';
        document.body.appendChild(host);
      }, process.env.PREVIEW_INJECT);
      await page.waitForTimeout(300);
    }
    // 名字带上布局线索，否则同一屏的模式/面板变体会互相覆盖
    await shot([SCREEN, process.env.PREVIEW_MODE, process.env.PREVIEW_RIGHT, THEME].filter(Boolean).join('-'));
    await browser.close();
    console.log(`\n截图输出：${OUT}`);
    return;
  }

  const scenario = `${process.env.PREVIEW_SCENARIO === 'long' ? 'long' : 'live'}-${THEME}`;

  // ① 整屏：Run 头 + 聚合行 + 实时终端 + 计划（长任务场景则是"已完成 + 历史折叠"）
  await shot(`01-run-overview-${scenario}`);
  if (scenario === 'long') {
    // 展开被折叠的历史，确认里面仍是真实行
    const folded = page.locator('[data-segment="folded"] [role="button"]').first();
    if (await folded.count()) {
      await folded.click();
      await page.waitForTimeout(250);
      await shot('02-folded-expanded');
    }
    await browser.close();
    console.log(`
截图输出：${OUT}`);
    return;
  }

  // ② 展开聚合段（读取 4 个文件）
  const agg = page.locator('[data-segment^="agg:read_file"] [role="button"]').first();
  if (await agg.count()) {
    await agg.click();
    await page.waitForTimeout(250);
    await shot('02-aggregate-expanded');
  }

  // ③ 展开一次改动（diff + ± 芯片）
  const edit = page.locator('[data-activity="edit_file"] [role="button"]').first();
  if (await edit.count()) {
    await edit.click();
    await page.waitForTimeout(250);
    await shot('03-edit-detail');
  }

  // ④ 权限行（审批卡片）
  const perm = page.locator('[data-activity="permission"]').first();
  if (await perm.count()) {
    await perm.scrollIntoViewIfNeeded();
    await shot('04-permission-row');
  }

  // ④b 子代理嵌套（§十七：层级清楚但不做树状图）
  const sub = page.locator('[data-activity="sub_agent"]').first();
  if (await sub.count()) {
    await sub.scrollIntoViewIfNeeded();
    await sub.locator('[role="button"]').first().click();
    await page.waitForTimeout(250);
    await shot('04b-subagent-nested');
  }

  // ⑤ 整条消息（含最终回答位置）—— 看层级：步骤 vs 正文
  await page.evaluate(() => document.querySelector('.chat-scroll-full')?.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await shot('05-top-of-run', { fullPage: false });

  await browser.close();
  if (errors.length) {
    console.error(`\n⚠️  渲染层抛出 ${errors.length} 个错误（不是真 Electron，某些 IPC 缺失属预期）：`);
    for (const e of errors.slice(0, 5)) console.error('  -', e);
    process.exitCode = 1;
  }
  console.log(`\n截图输出：${OUT}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
