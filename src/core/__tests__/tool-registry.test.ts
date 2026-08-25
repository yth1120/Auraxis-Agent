import { describe, it, expect } from 'vitest';
import { registerTools, unregisterTools, getPluginTools } from '../tool-registry';
import type { ToolDef } from '../../types/tools';

function mkTool(name: string): ToolDef {
  return {
    name: name as ToolDef['name'],
    description: `Tool: ${name}`,
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

describe('tool-registry', () => {
  // 每个测试前清空：需要 unregister 掉已注册的插件
  // 注意：registerTools/unregisterTools 操作模块级 Map，
  // 需要手动清理避免测试间污染
  function cleanup(pluginIds: string[]) {
    for (const id of pluginIds) {
      unregisterTools(id);
    }
  }

  it('空注册表 getPluginTools 返回 []', () => {
    expect(getPluginTools()).toEqual([]);
  });

  it('注册单个插件的工具', () => {
    const tools = [mkTool('read_file'), mkTool('write_file')];
    registerTools('plugin-a', tools);
    const all = getPluginTools();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.name)).toEqual(['read_file', 'write_file']);
    cleanup(['plugin-a']);
  });

  it('注册多个插件的工具并合并', () => {
    registerTools('plugin-a', [mkTool('tool-a')]);
    registerTools('plugin-b', [mkTool('tool-b1'), mkTool('tool-b2')]);
    const all = getPluginTools();
    expect(all).toHaveLength(3);
    expect(all.map((t) => t.name)).toEqual(['tool-a', 'tool-b1', 'tool-b2']);
    cleanup(['plugin-a', 'plugin-b']);
  });

  it('同一插件覆盖注册（Map.set 行为 — 覆盖旧注册）', () => {
    registerTools('plugin-x', [mkTool('old-tool')]);
    registerTools('plugin-x', [mkTool('new-tool-1'), mkTool('new-tool-2')]);
    const all = getPluginTools();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.name)).toEqual(['new-tool-1', 'new-tool-2']);
    cleanup(['plugin-x']);
  });

  it('注销已注册插件', () => {
    registerTools('plugin-c', [mkTool('temp-tool')]);
    expect(getPluginTools()).toHaveLength(1);
    unregisterTools('plugin-c');
    expect(getPluginTools()).toEqual([]);
  });

  it('注销不存在的插件不抛错', () => {
    expect(() => unregisterTools('nonexistent')).not.toThrow();
  });

  it('注销后再注册同一插件', () => {
    registerTools('plugin-d', [mkTool('v1')]);
    unregisterTools('plugin-d');
    registerTools('plugin-d', [mkTool('v2')]);
    const all = getPluginTools();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('v2');
    cleanup(['plugin-d']);
  });

  it('部分注销不影响其他插件', () => {
    registerTools('keep', [mkTool('keep-tool')]);
    registerTools('remove', [mkTool('remove-tool')]);
    unregisterTools('remove');
    const all = getPluginTools();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('keep-tool');
    cleanup(['keep']);
  });
});
