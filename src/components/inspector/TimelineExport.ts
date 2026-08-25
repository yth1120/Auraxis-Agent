import type { AgentInfo } from '@/types/agent';
import type { I18nKey } from '../../i18n';
import { fmtDuration, toolSummary, turnStats, type Turn } from './TimelineUtils';

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeName(agent: AgentInfo): string {
  return (agent.name || 'agent').replace(/[\\/:*?"<>|]/g, '_');
}

export function exportTrajectory(agent: AgentInfo) {
  const payload = {
    agent: agent.name,
    description: agent.description,
    exportedAt: new Date().toISOString(),
    log: agent.log,
  };
  downloadBlob(`${safeName(agent)}.trajectory.json`, new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
}

export function exportTrajectoryMarkdown(agent: AgentInfo, turns: Turn[], t: Translate) {
  const lines: string[] = [
    `# ${agent.name}`,
    '',
    agent.description ? `${agent.description}` : '',
    '',
    t('timeline.exportStatus', { status: agent.status }),
    t('timeline.exportRound', { n: agent.iteration ?? 0 }),
    t('timeline.exportToolCalls', { n: agent.toolCallCount ?? 0 }),
    '',
  ];
  for (const turn of turns) {
    const stats = turnStats(turn.end);
    lines.push(`${t('timeline.exportTurn', { n: turn.iteration })}${stats ? ` · ${stats}` : ''}`, '');
    for (const entry of turn.entries) {
      if (entry.type !== 'tool_start' && entry.type !== 'tool_end' && entry.type !== 'tool_error') {
        if (entry.type === 'text' && entry.text) lines.push(`> ${entry.text.replace(/\n/g, ' ').slice(0, 120)}`);
        continue;
      }
      const mark = entry.type === 'tool_error' ? '❌' : entry.type === 'tool_start' ? '🔄' : '✅';
      const summary = toolSummary(entry);
      const duration = entry.durationMs != null ? ` · ${fmtDuration(entry.durationMs)}` : '';
      lines.push(`- ${mark} **${entry.toolName}** ${summary ? `\`${summary}\`` : ''}${duration}`);
    }
    lines.push('');
  }
  downloadBlob(`${safeName(agent)}.trajectory.md`, new Blob([lines.filter((line) => line !== null).join('\n')], { type: 'text/markdown' }));
}
