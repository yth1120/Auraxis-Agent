export interface KeyBinding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  description: string;
  category: 'navigation' | 'chat' | 'agent' | 'system';
}

export const KEY_BINDINGS: KeyBinding[] = [
  // ── Navigation ──
  {
    key: 'k',
    ctrl: true,
    description: '打开命令面板',
    category: 'navigation',
  },
  {
    key: 'P',
    ctrl: true,
    shift: true,
    description: '打开命令面板',
    category: 'navigation',
  },
  {
    key: 'b',
    ctrl: true,
    description: '切换侧边栏',
    category: 'navigation',
  },
  {
    key: '/',
    ctrl: true,
    description: '切换侧边栏',
    category: 'navigation',
  },
  {
    key: 'i',
    ctrl: true,
    shift: true,
    description: '切换右侧面板',
    category: 'navigation',
  },
  {
    key: 'b',
    ctrl: true,
    alt: true,
    description: '切换右侧面板',
    category: 'navigation',
  },
  // ── Pane focus ──
  {
    key: '1',
    alt: true,
    description: '聚焦侧边栏',
    category: 'navigation',
  },
  {
    key: '2',
    alt: true,
    description: '聚焦主内容区',
    category: 'navigation',
  },
  {
    key: '3',
    alt: true,
    description: '聚焦右侧面板',
    category: 'navigation',
  },
  // ── Right-panel tab switching ──
  {
    key: '1',
    ctrl: true,
    shift: true,
    description: '右侧面板：执行详情',
    category: 'navigation',
  },
  {
    key: '2',
    ctrl: true,
    shift: true,
    description: '右侧面板：时间线',
    category: 'navigation',
  },
  {
    key: '3',
    ctrl: true,
    shift: true,
    description: '右侧面板：审查',
    category: 'navigation',
  },
  {
    key: '4',
    ctrl: true,
    shift: true,
    description: '右侧面板：预览',
    category: 'navigation',
  },
  {
    key: '`',
    ctrl: true,
    description: '打开集成终端',
    category: 'navigation',
  },
  // ── Chat ──
  {
    key: 'l',
    ctrl: true,
    description: '清空对话',
    category: 'chat',
  },
  {
    key: 'n',
    ctrl: true,
    description: '新建对话',
    category: 'chat',
  },
  // ── System ──
  {
    key: 'z',
    ctrl: true,
    description: '撤销最近操作',
    category: 'system',
  },
  {
    key: ',',
    ctrl: true,
    description: '打开设置',
    category: 'system',
  },
  {
    key: 'w',
    ctrl: true,
    description: '关闭当前标签页',
    category: 'system',
  },
  {
    key: 'Escape',
    description: '停止生成 / 关闭面板',
    category: 'system',
  },
];

export function matchBinding(e: KeyboardEvent, binding: KeyBinding, platform?: string): boolean {
  // Ctrl-bindings are Cmd-equivalent on macOS only. Treating Meta as Ctrl
  // everywhere makes Windows' Win key hijack app shortcuts (e.g. Win+K).
  const mac = /Mac|iPhone|iPad/.test(platform ?? (typeof navigator !== 'undefined' ? navigator.platform : ''));
  const ctrlPressed = e.ctrlKey || (mac && e.metaKey);
  if (binding.key !== e.key) return false;
  if (binding.ctrl !== undefined && binding.ctrl !== ctrlPressed) return false;
  if (binding.shift !== undefined && binding.shift !== e.shiftKey) return false;
  if (binding.alt !== undefined && binding.alt !== e.altKey) return false;
  if (binding.meta !== undefined && binding.meta !== e.metaKey) return false;
  return true;
}

/** Platform-aware Ctrl/Cmd check (Windows/Linux: Ctrl only; macOS: Ctrl or Cmd). */
export function isCtrlOrCmd(e: KeyboardEvent): boolean {
  const mac = /Mac|iPhone|iPad/.test(typeof navigator !== 'undefined' ? navigator.platform : '');
  return e.ctrlKey || (mac && e.metaKey);
}

export function formatBinding(b: KeyBinding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push('Ctrl');
  if (b.alt) parts.push('Alt');
  if (b.shift) parts.push('Shift');
  if (b.meta) parts.push('Meta');
  if (b.key === 'Escape') parts.push('Esc');
  else if (b.key === ' ') parts.push('Space');
  else if (b.key.length === 1) parts.push(b.key.toUpperCase());
  else parts.push(b.key);
  return parts.join('+');
}

export function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}
