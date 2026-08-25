import { Wrench } from '@/components/common/icons';
import type { AgentSkill } from '@/core/skills';
import { useT, agentSkillNameKey, agentSkillDescKey } from '../../i18n';
import clsx from 'clsx';

interface SkillMentionDropdownProps {
  skills: AgentSkill[];
  query: string;
  selected: number;
  position?: 'center' | 'center-flow' | 'bottom';
  onSelect: (skill: AgentSkill) => void;
  onHover: (idx: number) => void;
}

/** `$`-mention 技能下拉。 */
export default function SkillMentionDropdown({
  skills,
  query,
  selected,
  position,
  onSelect,
  onHover,
}: SkillMentionDropdownProps) {
  const t = useT();
  const q = query.trim().toLowerCase();
  const visible = skills.filter(
    (s) =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.key.includes(q) ||
      t(agentSkillNameKey(s.key)).toLowerCase().includes(q),
  );

  if (visible.length === 0) return null;

  return (
    <div
      className={clsx(
        'absolute left-[-6px] right-[-6px] bg-[var(--color-bg-elevated)] rounded-card overflow-hidden z-[100] max-h-[260px] flex flex-col border border-[var(--color-border-dim)] shadow-[var(--shadow-md)]',
        position === 'center' || position === 'center-flow' ? 'top-[calc(100%+6px)]' : 'bottom-[calc(100%+6px)]',
      )}
    >
      <div className="overflow-y-auto flex-1">
        {visible.map((skill, idx) => (
          <div
            key={skill.key}
            className={[
              'px-3 py-2 cursor-pointer text-text-secondary font-body text-sm flex items-center gap-2',
              'transition-colors duration-150',
              idx === selected ? 'bg-primary-soft text-text-primary' : 'hover:bg-primary-soft hover:text-text-primary',
            ].join(' ')}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(skill);
            }}
            onMouseEnter={() => onHover(idx)}
          >
            <span className="w-5 h-5 rounded-md flex items-center justify-center text-2xs shrink-0 bg-[var(--color-primary-soft)] text-primary">
              <Wrench size={12} weight="fill" />
            </span>
            <span className="min-w-0 flex flex-col gap-[1px]">
              <strong className="overflow-hidden text-ellipsis whitespace-nowrap">
                {t(agentSkillNameKey(skill.key))}
              </strong>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-2xs opacity-60">
                {t(agentSkillDescKey(skill.key))}
              </span>
            </span>
          </div>
        ))}
      </div>
      <div className="px-3 py-2 flex items-center gap-3 text-2xs text-text-faint border-t border-border-dim">
        <span className="flex items-center gap-1">
          <kbd className="inline-flex items-center justify-center min-w-[16px] p-1 rounded-[5px] bg-bg-inset text-xs text-text-muted border border-border-dim">
            ↑↓
          </kbd>{' '}
          {t('nav.navigate')}
        </span>
        <span className="flex items-center gap-1">
          <kbd className="inline-flex items-center justify-center min-w-[16px] p-1 rounded-[5px] bg-bg-inset text-xs text-text-muted border border-border-dim">
            ↵
          </kbd>{' '}
          {t('nav.select')}
        </span>
        <span className="flex items-center gap-1">
          <kbd className="inline-flex items-center justify-center min-w-[16px] p-1 rounded-[5px] bg-bg-inset text-xs text-text-muted border border-border-dim">
            Esc
          </kbd>{' '}
          {t('nav.cancel')}
        </span>
      </div>
    </div>
  );
}
