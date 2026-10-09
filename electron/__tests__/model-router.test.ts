import { describe, expect, it } from 'vitest';
import { classifyTaskDifficulty, routeModel } from '../agent-runtime/model-router';

const config = { model: 'fast-model', planModel: 'strong-model', fallbackModel: 'backup-model' };

describe('难度路由', () => {
  it('难度分类：读一读/改一行 → low，重构架构 → high', () => {
    expect(classifyTaskDifficulty('读一下 README')).toBe('low');
    // 一行改动就该走常规模型——这正是路由要的效果，不要为了"看起来更努力"升级。
    expect(classifyTaskDifficulty('把 src/config.ts 的 retryCount 改成 5')).toBe('low');
    expect(classifyTaskDifficulty('实现一个新的搜索接口并补测试')).toBe('medium');
    expect(classifyTaskDifficulty('重构整个项目的架构')).toBe('high');
  });

  it('低难度用常规模型，高难度升级到强模型', () => {
    expect(routeModel('读一下 README', config)).toMatchObject({ model: 'fast-model', reason: 'baseline' });
    expect(routeModel('重构整个项目的架构', config)).toMatchObject({
      model: 'strong-model',
      reason: 'difficulty-high',
    });
  });

  // 「连续失败就升级」曾经在这里被测过，但它**永远走不到**：路由只发生在开跑之前，
  // 生产调用点也没有失败计数可传。已连同参数一起删除 —— 测一条线上不可达的分支
  // 只会给出"这个能力存在"的错觉。开跑后的失败由 step-engine 的 fallbackModel 兜底。


  it('用户显式指定的模型永远优先；没有强模型配置时不猜模型名', () => {
    expect(routeModel('重构架构', config, { explicitModel: 'user-picked' })).toMatchObject({
      model: 'user-picked',
      reason: 'explicit',
    });
    const noStrong = { model: 'only-model' };
    expect(routeModel('重构架构', noStrong).model).toBe('only-model');
  });

  it('显式 fast/strong 档位优先于 model/planModel（默认留空 = 行为不变）', () => {
    const tiers = { model: 'base', fastModel: 'fast', strongModel: 'strong', planModel: 'plan' };
    expect(routeModel('读一下 README', tiers)).toMatchObject({ model: 'fast', reason: 'fast-tier' });
    expect(routeModel('重构整个项目的架构', tiers)).toMatchObject({ model: 'strong', reason: 'difficulty-high' });
    // 中等难度保持主模型（fast 只服务轻任务）。
    expect(routeModel('实现一个新的搜索接口并补测试', tiers).model).toBe('base');
    // 只配 fast 时高难度回落主模型 / planModel，绝不跑在 fast 上。
    expect(routeModel('重构架构', { model: 'base', fastModel: 'fast' }).model).toBe('base');
    expect(routeModel('重构架构', { model: 'base', fastModel: 'fast', planModel: 'plan' }).model).toBe('plan');
  });
});
