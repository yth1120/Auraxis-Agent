/**
 * 模式显示名的唯一来源。
 *
 * 顶部模式切换器与顶部信息区必须显示同一个名字——历史上切换器把「对话」写成
 * "Chat"（按用户要求），而信息区仍读 `mode.chat`（「对话」），于是同一屏出现两
 * 个叫法。这里收敛成一处，两边都从这里取。
 */
import type { I18nKey } from '../../i18n';

export type ModeKeyLabel = 'chat' | 'work' | 'code';

type Translate = (key: I18nKey) => string;

/** 对话模式按产品要求显示为 "Chat"（其余文案保持中文，走 i18n）。 */
export function modeLabel(mode: ModeKeyLabel, t: Translate): string {
  if (mode === 'chat') return 'Chat';
  return t(mode === 'work' ? 'mode.work' : 'mode.agent');
}
