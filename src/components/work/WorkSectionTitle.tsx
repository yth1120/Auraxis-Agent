/**
 * WorkSectionTitle — Work 任务视图内各分区（计划 / 执行 / 交付物 / 质量门 / 交付验收）的统一分区标题。
 *
 * 分区本身**不带底色与描边**：Work 视图里只有一张「任务头卡」承担卡片外观，
 * 其余分区靠标题与间距分隔，避免出现卡片套卡片的两层界面。
 */
import type { ReactNode } from 'react';

export default function WorkSectionTitle({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-[var(--color-bg-inset)] text-text-muted">
        {icon}
      </span>
      <span className="text-xs font-semibold text-text-secondary tracking-[0.04em] uppercase">{label}</span>
    </div>
  );
}
