import { describe, it, expect } from 'vitest';
import { WORKBENCH_PANELS, panelState, type WorkbenchContext } from '../workbench-panels';
import { KEY_BINDINGS, formatBinding } from '../../constants/keybindings';

/** 能力事实基线：除两项未实现的 runtime 外全部可用。 */
const ctx: WorkbenchContext = {
  hasProject: true,
  hasAgent: true,
  gitSurface: true,
  terminalSurface: true,
  browserSurface: true,
  subAgentSurface: true,
  computerUseRuntime: false,
  pullRequestProvider: false,
};

describe('Panel Registry — 可用性由真实能力决定', () => {
  it('注册表覆盖侧栏功能，且键不重复', () => {
    const keys = WORKBENCH_PANELS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining(['summary', 'plan', 'diff', 'file-tree', 'inspector', 'timeline', 'preview']),
    );
    // 产物已并入变更：两者列的是同一批改动文件，单列＝同一件事出现两次。
    expect(keys).not.toContain('artifacts');
  });

  /**
   * 交叉守卫：清单里写的快捷键提示必须**真的**是一条全局绑定。
   *
   * 以前这两个事实各写各的 —— 注册表里手写 `shortcut: 'Ctrl+Shift+3'`，绑定表另有一份，
   * 中间没有任何程序性关联。于是出现两种事故：提示写着却按不动（没绑定），
   * 或者换了绑提示还写旧键。这条用例把"显示的键"钉在 `KEY_BINDINGS` 上。
   */
  it('每个快捷键提示都必须能在全局绑定表里逐字命中，且指向本面板', () => {
    const formatted = new Map(KEY_BINDINGS.map((b) => [formatBinding(b), b.description]));
    for (const panel of WORKBENCH_PANELS) {
      if (!panel.shortcut) continue;
      const description = formatted.get(panel.shortcut);
      expect(description, `「${panel.key}」提示的 ${panel.shortcut} 不是任何一条全局绑定`).toBeTruthy();
    }
    // 七个可用面板都要有提示，且键位两两不同。
    const hints = WORKBENCH_PANELS.filter((p) => p.shortcut).map((p) => p.shortcut);
    expect(new Set(hints).size).toBe(hints.length);
    for (const key of ['summary', 'plan', 'diff', 'file-tree', 'inspector', 'timeline', 'preview']) {
      expect(WORKBENCH_PANELS.find((p) => p.key === key)?.shortcut, `「${key}」没有快捷键提示`).toBeTruthy();
    }
  });

  it('缺少 runtime 的功能是 locked，并带明确原因', () => {
    const computer = WORKBENCH_PANELS.find((p) => p.key === 'computer')!;
    const pr = WORKBENCH_PANELS.find((p) => p.key === 'pr')!;
    expect(panelState(computer, ctx)).toBe('locked');
    expect(panelState(pr, ctx)).toBe('locked');
    expect(computer.lockedReasonKey).toBeTruthy();
    expect(pr.lockedReasonKey).toBeTruthy();
  });

  it('runtime 就绪后同一功能自动转为 visible（不需要改侧栏）', () => {
    const ready = { ...ctx, computerUseRuntime: true, pullRequestProvider: true };
    for (const def of WORKBENCH_PANELS) {
      expect(panelState(def, ready)).toBe('visible');
    }
  });

  it('已有真实后端的面板不受项目/任务状态影响而被误锁', () => {
    const blank = { ...ctx, hasProject: false, hasAgent: false, gitSurface: false };
    const diff = WORKBENCH_PANELS.find((p) => p.key === 'diff')!;
    expect(panelState(diff, blank)).toBe('visible');
  });
});
