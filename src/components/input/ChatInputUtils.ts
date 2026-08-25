import { t, type I18nKey } from '../../i18n';
import { PERMISSION_PRESETS, type PermissionPreset } from '../../types/advanced';
import type { WorkAutonomyTier } from '../../types/advanced';
export function greeting(now = Date.now()): string {
  const h = new Date(now).getHours();
  if (h < 6) return t('chat.greeting.night');
  if (h < 12) return t('chat.greeting.morning');
  if (h < 18) return t('chat.greeting.afternoon');
  return t('chat.greeting.evening');
}

interface PendingImage {
  name: string;
  dataUrl: string;
  start: number;
  end: number;
}

/** Parse `【图片: name】\n<dataUrl>` blocks currently sitting in the composer. */
export function parsePendingImages(text: string): PendingImage[] {
  const out: PendingImage[] = [];
  const re = /【图片: ([^\n】]*)】\s*\n?(data:image\/[^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ name: m[1] || t('chat.image'), dataUrl: m[2], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export interface ChatInputProps {
  position?: 'center' | 'center-flow' | 'bottom';
  /** 居中 Hero 模式的副标题文案 key（默认聊天通用提示）。 */
  heroSubtitleKey?: I18nKey;
}

/** Preset → background-agent config (type + permission mode + auto-approve).
 *  The canonical mapping lives in electron/contracts/permission.ts — keep the
 *  two in sync; plan mode is armed separately via /plan / Work mode. */
export function resolveAgentConfig(preset: PermissionPreset): {
  type: 'general-purpose';
  mode: 'ask' | 'auto';
  autoApprove: boolean;
} {
  const spec = PERMISSION_PRESETS[preset];
  return { type: 'general-purpose', mode: spec.mode, autoApprove: spec.autoApprove };
}

/** Plan overlay: approval becomes the authorization step, but the preset's
 *  autoApprove axis is preserved (full → bypass hygiene after approval). */
export function resolvePlanAgentConfig(preset: PermissionPreset): {
  type: 'general-purpose';
  mode: 'plan';
  autoApprove: boolean;
} {
  return {
    type: 'general-purpose',
    mode: 'plan',
    autoApprove: PERMISSION_PRESETS[preset].autoApprove,
  };
}

/** Work 档位 → 后端审批策略。smart 走 ask + 分级门禁；full 走 auto +
 * 高危仍问；plan 走 plan（计划审批后计划内自动）。 */
export function resolveWorkAgentConfig(tier: WorkAutonomyTier): {
  type: 'general-purpose';
  mode: 'ask' | 'plan' | 'auto';
  autoApprove: boolean;
} {
  if (tier === 'plan') return { type: 'general-purpose', mode: 'plan', autoApprove: false };
  if (tier === 'full') return { type: 'general-purpose', mode: 'auto', autoApprove: false };
  return { type: 'general-purpose', mode: 'ask', autoApprove: false };
}
export function parseTreePaths(treeText: string): string[] {
  const lines = treeText.split('\n').filter(Boolean);
  const paths: string[] = [];
  const dirStack: { name: string; depth: number }[] = [];

  for (const line of lines) {
    const stripped = line.replace(/^[│\s]+/, '');
    const depth = (line.match(/^(?:│ {3}| {4})*/)?.[0]?.length ?? 0) / 4;
    const name = stripped.replace(/^[├└]── /, '');

    if (!name) continue;

    while (dirStack.length > 0 && dirStack[dirStack.length - 1].depth >= depth) {
      dirStack.pop();
    }

    if (name.endsWith('/')) {
      dirStack.push({ name: name.slice(0, -1), depth });
    } else {
      const dirPath = dirStack.map((d) => d.name).join('/');
      const fullPath = dirPath ? `${dirPath}/${name}` : name;
      paths.push(fullPath);
    }
  }

  return paths;
}
