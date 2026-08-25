import { useMemo, useState } from 'react';
import { useT } from '../../i18n';
import type { AgentInfo } from '../../types/agent';
import { workTurns } from './workUtils';
import { TurnCard } from './WorkExecutionFlowParts';

/**
 * Work mode's dedicated execution flow: turns (iterations) with live running
 * state, assistant notes, plan updates, warnings and expandable tool details.
 * Kept deliberately separate from Code mode's AgentConversation stream.
 */
export default function WorkExecutionFlow({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const turns = useMemo(() => workTurns(agent), [agent]);
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(() => new Set());
  const running = agent.status === 'running';

  const toggleTurn = (id: string) => {
    setCollapsedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTool = (key: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (turns.length === 0) {
    return <div className="px-1 py-2 text-2xs text-text-muted">{t('work.waitingExecution')}</div>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {turns.map((turn) => (
        <TurnCard
          key={turn.id}
          turn={turn}
          running={running}
          collapsed={collapsedTurns.has(turn.id)}
          expandedTools={expandedTools}
          onToggleTurn={() => toggleTurn(turn.id)}
          onToggleTool={toggleTool}
        />
      ))}
    </div>
  );
}
