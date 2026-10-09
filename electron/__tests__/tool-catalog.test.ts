import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '../tool-defs';
import {
  groupOfTool,
  LEARNED_CORE_TOOLS,
  resolveToolSearch,
  selectToolGroups,
  selectToolsForTask,
  TOOL_SEARCH_DEF,
} from '../agent-runtime/tool-catalog';

const names = (task: string, surface = 'code') =>
  selectToolsForTask(TOOL_DEFINITIONS, { task, surface }).map((t) => t.name);

describe('动态工具装载', () => {
  it('发现入口：按分组 / 自然语言放开工具，且不重复放已加载的', () => {
    expect(TOOL_SEARCH_DEF.name).toBe('ToolSearch');
    const core = selectToolsForTask(TOOL_DEFINITIONS, { task: '修 bug' });
    const added = resolveToolSearch(TOOL_DEFINITIONS, { groups: ['integrate'] }, core).map((t) => t.name);
    expect(added).toEqual(expect.arrayContaining(['SlackPostMessage', 'NotionSearch', 'WebFetch']));
    expect(added).not.toContain('Read'); // 已在核心集，不重复放
    expect(resolveToolSearch(TOOL_DEFINITIONS, { query: '帮我抓取网页' }, core).map((t) => t.name)).toContain(
      'WebFetch',
    );
    expect(resolveToolSearch(TOOL_DEFINITIONS, {}, core)).toEqual([]); // 未请求就不放开
    expect(resolveToolSearch(TOOL_DEFINITIONS, { groups: ['bogus'] }, core)).toEqual([]); // 非法分组忽略
  });

  it('内置工具必须全部归类（否则会被静默丢弃）', () => {
    const ungrouped = TOOL_DEFINITIONS.filter((t) => groupOfTool(t.name) === 'misc').map((t) => t.name);
    expect(ungrouped).toEqual([]);
  });

  it('编码任务默认就是学习核心集，且丢掉集成类', () => {
    const picked = names('把 src/config.ts 的 apiTimeoutMs 改成 60000 并跑 node check.mjs');
    for (const tool of LEARNED_CORE_TOOLS) expect(picked, `缺少 ${tool}`).toContain(tool);
    expect(picked.length).toBeLessThanOrEqual(LEARNED_CORE_TOOLS.length + 4);
    expect(picked).not.toEqual(expect.arrayContaining(['SlackPostMessage', 'NotionSearch', 'CronCreate']));
  });

  it('按信号加载：提到网页才给 WebFetch，提到子代理才给 Agent', () => {
    expect(names('读一下 README')).not.toContain('WebFetch');
    expect(names('抓取这个网页并总结')).toContain('WebFetch');
    expect(names('并行开两个子代理调研')).toContain('Agent');
  });

  it('chat 面只读：不给写与执行工具', () => {
    const picked = names('解释一下这段代码', 'chat');
    expect(picked).toContain('Read');
    expect(picked).not.toEqual(expect.arrayContaining(['Write', 'Edit', 'Bash']));
  });

  it('预选确实显著瘦身（相对全量）', () => {
    const all = TOOL_DEFINITIONS.length;
    const coding = names('修一个 TypeScript bug').length;
    expect(coding).toBeLessThan(all * 0.2);
    expect(selectToolGroups({ task: '修 bug' }).has('integrate')).toBe(false);
    expect(selectToolGroups({ task: '修 bug' }).has('meta')).toBe(false);
  });
});

/**
 * 回归守卫：预选**不得**据名字丢掉来路不明的工具。
 *
 * 实测过的场景 —— `mcp__exa__search` 落不进任何分组正则 → `misc` → 而 `misc` 从不出现在
 * 被选中的分组里，于是它被静默丢弃。预选之前这三条路径拿的是全量 `getAllTools()`，
 * 所以这是动态装载引入的回归：装了 MCP，agent 却看不见自己的工具。
 */
describe('外部来源工具不得被预选丢弃', () => {
  const external = [
    { name: 'mcp__exa__search' },
    { name: 'mcp__filesystem.read' }, // 带点 → 会被算进 integrate，同样不该丢
    { name: 'someplugin_do_thing' },
  ];
  const all = [...TOOL_DEFINITIONS, ...external];

  it('没有任何任务信号时，MCP 与插件工具仍在表里', () => {
    const picked = selectToolsForTask(all, { task: '改一行常量' }).map((t) => t.name);
    for (const t of external) expect(picked, `缺少 ${t.name}`).toContain(t.name);
  });

  it('保留集不削弱真正的预选：内置集成类仍然按信号加载', () => {
    const picked = selectToolsForTask(all, { task: '改一行常量' }).map((t) => t.name);
    // 这两条是"少给"的收益所在，不能被保留集顺手放开
    expect(picked).not.toContain('SlackPostMessage');
    expect(picked).not.toContain('CronCreate');
    // 内置工具全部已归类，所以保留集对它们没有任何影响
    expect(TOOL_DEFINITIONS.filter((t) => t.name.startsWith('mcp__'))).toHaveLength(0);
  });

  it('宿主可以用 retain 覆盖判据（例如只保留注册表认定的外部来源）', () => {
    const picked = selectToolsForTask(all, { task: '改一行常量', retain: () => false }).map((t) => t.name);
    expect(picked).not.toContain('mcp__exa__search');
  });
});
