import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { agentSkillNameKey, type I18nKey } from '../../i18n';
import { useSessionStore } from '../../stores/useSessionStore';
import type { AgentSkill } from '../../core/skills';
import { AGENT_SKILLS } from '../../core/skills';
import { listSlashCommands } from '../../utils/slashCommands';
import type { SlashCommand } from '../../constants/commands';
import { parseTreePaths } from './ChatInputUtils';

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;

export function useChatInputMentions({
  projectPath,
  inputValue,
  textareaRef,
  isAgentSurface,
  t,
}: {
  projectPath: string | null;
  inputValue: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  isAgentSurface: boolean;
  t: Translate;
}) {
  const allSessions = useSessionStore((s) => s.sessions);
  const mentionFetchRef = useRef(0);
  const mentionDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(-1);
  const [mentionItems, setMentionItems] = useState<string[]>([]);
  const [mentionSessions, setMentionSessions] = useState<{ id: string; title: string }[]>([]);
  const [mentionSelected, setMentionSelected] = useState(0);
  const [allFilePaths, setAllFilePaths] = useState<string[]>([]);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandIndex, setCommandIndex] = useState(-1);
  const [commandItems, setCommandItems] = useState<SlashCommand[]>([]);
  const [commandSelected, setCommandSelected] = useState(0);
  const [dollarOpen, setDollarOpen] = useState(false);
  const [dollarIndex, setDollarIndex] = useState(-1);
  const [dollarQuery, setDollarQuery] = useState('');
  const [dollarSelected, setDollarSelected] = useState(0);
  const [backendSkills, setBackendSkills] = useState<AgentSkill[]>([]);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.skills
      ?.list()
      .then((result) => {
        if (cancelled || !result?.ok || !result.data) return;
        setBackendSkills(
          result.data.skills.map((skill) => ({
            key: skill.name,
            name: skill.name,
            description: skill.description,
            type: 'general-purpose' as const,
            icon: 'feature' as const,
            instruction: skill.whenToUse ? `${skill.description}\n\n何时使用：${skill.whenToUse}` : skill.description,
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const allSkills = useMemo(() => {
    const seen = new Set(AGENT_SKILLS.map((skill) => skill.name).concat(AGENT_SKILLS.map((skill) => skill.key)));
    return [...AGENT_SKILLS, ...backendSkills.filter((skill) => !seen.has(skill.name) && !seen.has(skill.key))];
  }, [backendSkills]);

  const dollarSkills = useMemo(() => {
    const query = dollarQuery.trim().toLowerCase();
    return allSkills.filter(
      (skill) =>
        !query ||
        skill.name.toLowerCase().includes(query) ||
        skill.key.includes(query) ||
        t(agentSkillNameKey(skill.key)).toLowerCase().includes(query),
    );
  }, [dollarQuery, allSkills, t]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!projectPath || !api?.context) {
      setAllFilePaths([]);
      return;
    }
    const fetchId = ++mentionFetchRef.current;
    void (async () => {
      const [tree, plans] = await Promise.all([
        api.context.getFileStructure(projectPath),
        api.plan?.list(projectPath) ?? Promise.resolve({ ok: false as const }),
      ]);
      if (fetchId !== mentionFetchRef.current) return;
      const paths = tree.ok && tree.data ? parseTreePaths(tree.data) : [];
      if (plans?.ok && plans.data) {
        for (const plan of plans.data) {
          const relative = plan.relative || plan.name;
          if (relative) paths.push(relative);
        }
      }
      setAllFilePaths(paths);
    })();
  }, [projectPath]);

  useEffect(() => {
    clearTimeout(mentionDebounceRef.current);
    mentionDebounceRef.current = setTimeout(() => {
      const cursorPos = textareaRef.current?.selectionStart ?? inputValue.length;
      const textBefore = inputValue.slice(0, cursorPos);
      const atIndex = textBefore.lastIndexOf('@');
      const slashIndex = textBefore.lastIndexOf('/');
      const dollarIndex = textBefore.lastIndexOf('$');
      if (slashIndex > atIndex && slashIndex > dollarIndex) {
        const query = textBefore.slice(slashIndex + 1);
        if (!query.includes(' ') && !query.includes('\n') && !query.includes('/')) {
          setCommandIndex(slashIndex);
          setCommandQuery(query);
          const filtered = listSlashCommands()
            .filter((command) => command.name.startsWith(query.toLowerCase()))
            .slice(0, 6);
          setCommandItems(filtered);
          setCommandSelected(0);
          setCommandOpen(filtered.length > 0);
        } else {
          setCommandOpen(false);
        }
        setMentionOpen(false);
        setDollarOpen(false);
      } else if (dollarIndex > atIndex && isAgentSurface) {
        const query = textBefore.slice(dollarIndex + 1);
        if (!query.includes(' ') && !query.includes('\n') && !query.includes('$')) {
          setDollarIndex(dollarIndex);
          setDollarQuery(query);
          setDollarSelected(0);
          setDollarOpen(true);
        } else {
          setDollarOpen(false);
        }
        setMentionOpen(false);
        setCommandOpen(false);
      } else if (atIndex >= 0) {
        const query = textBefore.slice(atIndex + 1);
        if (!query.includes(' ') && !query.includes('\n') && !query.includes('@')) {
          setMentionIndex(atIndex);
          setMentionQuery(query);
          const filtered = allFilePaths.filter((path) => path.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
          const sessions = allSessions
            .filter((session) => (session.title || '').toLowerCase().includes(query.toLowerCase()))
            .slice(0, 4)
            .map((session) => ({ id: session.id, title: session.title }));
          setMentionItems(filtered);
          setMentionSessions(sessions);
          setMentionSelected(0);
          setMentionOpen(filtered.length > 0 || sessions.length > 0);
        } else {
          setMentionOpen(false);
        }
        setCommandOpen(false);
        setDollarOpen(false);
      } else {
        setMentionOpen(false);
        setCommandOpen(false);
        setDollarOpen(false);
      }
    }, 60);
    return () => clearTimeout(mentionDebounceRef.current);
  }, [inputValue, allFilePaths, allSessions, isAgentSurface, textareaRef]);

  return {
    mentionOpen,
    mentionQuery,
    mentionIndex,
    mentionItems,
    mentionSessions,
    mentionSelected,
    setMentionOpen,
    setMentionIndex,
    setMentionSelected,
    commandOpen,
    commandQuery,
    commandIndex,
    commandItems,
    commandSelected,
    setCommandOpen,
    setCommandIndex,
    setCommandSelected,
    dollarOpen,
    dollarIndex,
    dollarQuery,
    dollarSelected,
    setDollarOpen,
    setDollarIndex,
    setDollarSelected,
    allSkills,
    dollarSkills,
  };
}
