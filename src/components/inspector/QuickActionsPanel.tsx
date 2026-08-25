import type { ReactNode } from 'react';
import {
  ArrowsClockwise,
  Bug,
  Flask,
  Lightning,
  MagnifyingGlass as SearchIcon,
  TreeStructure,
} from '@/components/common/icons';
import { AGENT_SKILLS, type AgentSkillIconKey } from '../../core/skills';
import { useChatStore } from '../../stores/useChatStore';
import { useT, agentSkillNameKey, agentSkillDescKey } from '../../i18n';

const SKILL_ICONS: Record<AgentSkillIconKey, ReactNode> = {
  search: <SearchIcon size={20} weight="regular" />,
  bug: <Bug size={20} weight="regular" />,
  refactor: <ArrowsClockwise size={20} weight="regular" />,
  test: <Flask size={20} weight="regular" />,
  architecture: <TreeStructure size={20} weight="regular" />,
  feature: <Lightning size={20} weight="regular" />,
};

/** Home row keeps the four execution-oriented starters; read-only analysis
 *  flows (code review / architecture) stay available via /skill commands. */
const HOME_SKILL_KEYS = new Set(['bug-fix', 'refactor', 'test-gen', 'feature-dev']);

/** Skills surfaced on the agent home — exactly four, one row. */
export const HOME_SKILLS = AGENT_SKILLS.filter((skill) => HOME_SKILL_KEYS.has(skill.key));

/**
 * Agent home quick-function panel: four execution cards (icon + name +
 * description) in a single row. Clicking fills the composer with the skill's
 * prompt and focuses it — the user reviews and presses Enter to send.
 */
export default function QuickActionsPanel() {
  const t = useT();
  return (
    <section className="mb-12 last:mb-0">
      <div className="mx-auto grid max-w-[720px] grid-cols-4 gap-2.5">
        {HOME_SKILLS.map((skill) => (
          <button
            key={skill.key}
            type="button"
            className="group flex flex-col items-center justify-center gap-2 h-[124px] min-w-0 px-2 rounded-2xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] text-center cursor-pointer transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] hover:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
            onClick={() => {
              useChatStore.getState().setInputValue(skill.instruction);
              useChatStore.getState().requestComposerFocus();
            }}
            title={t(agentSkillDescKey(skill.key))}
            aria-label={`${t(agentSkillNameKey(skill.key))}：${t(agentSkillDescKey(skill.key))}`}
          >
            <span className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--color-bg-elevated)] ring-1 ring-[var(--color-border-dim)] text-text-primary transition-colors duration-150 group-hover:ring-[var(--color-border-strong)]">
              {SKILL_ICONS[skill.icon]}
            </span>
            <span className="min-w-0 w-full flex flex-col items-center gap-0.5">
              <span className="block text-sm font-medium text-text-primary leading-snug truncate">
                {t(agentSkillNameKey(skill.key))}
              </span>
              <span className="block w-full text-2xs text-text-muted leading-[1.4] truncate px-1">
                {t(agentSkillDescKey(skill.key))}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
