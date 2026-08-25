/**
 * i18n — lightweight app-chrome translation.
 *
 * Scope: application shell (sidebar / header / workbench / composer / common
 * controls). Message content, tool descriptions, and settings panes remain
 * Chinese-first for now; the dictionary is typed so new keys are compile-checked.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useCallback } from 'react';
import { zhCN, type I18nKey } from './zh-CN';
import { enUS } from './en-US';

export type Locale = 'zh-CN' | 'en-US';
export type { I18nKey };

const dictionaries: Record<Locale, Record<I18nKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

interface I18nStore {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useI18nStore = create<I18nStore>()(
  persist(
    (set) => ({
      locale: 'zh-CN',
      setLocale: (locale) => set({ locale }),
    }),
    { name: 'auraxis-locale' },
  ),
);

function translate(locale: Locale, key: I18nKey, vars?: Record<string, string | number>): string {
  const dict = dictionaries[locale] ?? zhCN;
  let text: string = dict[key] ?? zhCN[key] ?? String(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return text;
}

export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  return translate(useI18nStore.getState().locale, key, vars);
}

const SLASH_DESC_KEYS: Record<string, I18nKey> = {
  clear: 'cmd.desc.clear',
  model: 'cmd.desc.model',
  agent: 'cmd.desc.agent',
  goal: 'cmd.desc.goal',
  plan: 'cmd.desc.plan',
  review: 'cmd.desc.review',
  skill: 'cmd.desc.skill',
  workflow: 'cmd.desc.workflow',
  memories: 'cmd.desc.memories',
  feedback: 'cmd.desc.feedback',
  theme: 'cmd.desc.theme',
  help: 'cmd.desc.help',
};

/** Slash command display description key (registry keeps stable ids). */
export function slashCommandDescKey(name: string): I18nKey {
  return SLASH_DESC_KEYS[name] ?? 'cmd.desc.help';
}

const KB_DESC_KEYS: Record<string, I18nKey> = {
  打开命令面板: 'kb.openPalette',
  切换侧边栏: 'kb.toggleSidebar',
  切换右侧面板: 'kb.toggleRightPanel',
  聚焦侧边栏: 'kb.focusSidebar',
  聚焦主内容区: 'kb.focusMain',
  聚焦右侧面板: 'kb.focusRight',
  '右侧面板：执行详情': 'kb.rightPlan',
  '右侧面板：时间线': 'kb.rightTimeline',
  '右侧面板：审查': 'kb.rightReview',
  '右侧面板：预览': 'kb.rightPreview',
  打开集成终端: 'kb.openTerminal',
  清空对话: 'kb.clearChat',
  新建对话: 'kb.newChat',
  撤销最近操作: 'kb.undo',
  打开设置: 'kb.openSettings',
  关闭当前标签页: 'kb.closeTab',
  '停止生成 / 关闭面板': 'kb.escape',
};

/** Keybinding display description key (registry descriptions stay stable ids). */
export function keybindingDescKey(description: string): I18nKey {
  return KB_DESC_KEYS[description] ?? 'kb.openPalette';
}

const SKILL_NAME_KEYS: Record<string, I18nKey> = {
  'code-review': 'skill.codeReview.name',
  'bug-fix': 'skill.bugFix.name',
  refactor: 'skill.refactor.name',
  'test-gen': 'skill.testGen.name',
  architecture: 'skill.architecture.name',
  'feature-dev': 'skill.featureDev.name',
};

const SKILL_DESC_KEYS: Record<string, I18nKey> = {
  'code-review': 'skill.codeReview.desc',
  'bug-fix': 'skill.bugFix.desc',
  refactor: 'skill.refactor.desc',
  'test-gen': 'skill.testGen.desc',
  architecture: 'skill.architecture.desc',
  'feature-dev': 'skill.featureDev.desc',
};

/** Built-in skill display name key (registry keeps stable ids). */
export function agentSkillNameKey(key: string): I18nKey {
  return SKILL_NAME_KEYS[key] ?? 'skill.codeReview.name';
}

/** Built-in skill display description key. */
export function agentSkillDescKey(key: string): I18nKey {
  return SKILL_DESC_KEYS[key] ?? 'skill.codeReview.desc';
}

/** Reactive translator hook — components re-render on locale change. */
export function useT() {
  const locale = useI18nStore((s) => s.locale);
  return useCallback((key: I18nKey, vars?: Record<string, string | number>) => translate(locale, key, vars), [locale]);
}
