import { useEffect, useState } from 'react';
import { Button, Input, message } from 'antd';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useT } from '../../i18n';
import InlineEmpty from '../common/InlineEmpty';
import { SettingsPaneHeader } from './SettingsPanes';

export function SettingsActionsPane() {
  const t = useT();
  const projectPath = useSettingsStore((s) => s.projectPath);
  const [projectActions, setProjectActions] = useState<{ name: string; command: string; platform?: string }[]>([]);

  useEffect(() => {
    if (!projectPath) {
      setProjectActions([]);
      return;
    }
    window.electronAPI?.actions
      ?.list(projectPath)
      .then((r) => setProjectActions(r.ok && r.data ? r.data : []))
      .catch(() => setProjectActions([]));
  }, [projectPath]);

  return (
    <>
      <SettingsPaneHeader title={t('settings.item.actions')} description={t('settings.actionsDesc')} />
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold text-text-primary">{t('settings.projectCommands')}</span>
        {projectPath && (
          <span className="text-2xs text-text-faint font-mono truncate max-w-[220px]">
            {projectPath}/.auraxis/actions.json
          </span>
        )}
      </div>
      {!projectPath ? (
        <InlineEmpty description={t('settings.actionsNeedProject')} compact />
      ) : projectActions.length === 0 ? (
        <InlineEmpty description={t('settings.actionsNotFound')} compact />
      ) : (
        <ul className="list-none m-0 p-0 flex flex-col gap-2">
          {projectActions.map((a) => (
            <li key={a.name} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--color-bg-secondary)]">
              <span className="text-sm font-medium text-text-primary">{a.name}</span>
              {a.platform && <span className="text-2xs text-text-muted">{a.platform}</span>}
              <code className="ml-auto text-xs text-text-muted font-mono truncate max-w-[260px]">{a.command}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 text-xs text-text-muted leading-[1.6]">
        {t('settings.actionsFormat', { code: '{"actions":[{"name":"Run","command":"npm start"}]}' })}
      </div>
    </>
  );
}

export function SettingsWorkflowsPane() {
  const t = useT();
  const projectPath = useSettingsStore((s) => s.projectPath);
  const [workflows, setWorkflows] = useState<
    {
      id: string;
      name: string;
      description?: string;
      source?: 'json' | 'markdown';
      steps: { id: string; name: string }[];
    }[]
  >([]);
  const [workflowRuns, setWorkflowRuns] = useState<
    { runId: string; workflowName: string; status: string; startedAt: number; endedAt?: number }[]
  >([]);

  useEffect(() => {
    const refresh = async () => {
      const [w, r] = await Promise.all([
        window.electronAPI?.workflow?.list(projectPath ?? undefined),
        window.electronAPI?.workflow?.runs(),
      ]);
      setWorkflows(w?.ok && w.data ? w.data : []);
      setWorkflowRuns(r?.ok && r.data ? r.data : []);
    };
    void refresh();
  }, [projectPath]);

  return (
    <>
      <SettingsPaneHeader title={t('settings.item.workflows')} description={t('settings.workflowsDesc')} />
      {!projectPath ? (
        <InlineEmpty description={t('settings.actionsNeedProject')} compact />
      ) : workflows.length === 0 ? (
        <InlineEmpty description={t('settings.workflowsNotFound')} compact />
      ) : (
        <ul className="list-none m-0 p-0 flex flex-col gap-2">
          {workflows.map((wf) => (
            <li key={wf.id} className="px-4 py-3 rounded-xl bg-[var(--color-bg-secondary)]">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text-primary">{wf.name}</span>
                <span className="text-2xs text-text-muted">{t('settings.stepsN', { n: wf.steps.length })}</span>
                <span className="inline-flex items-center h-5 px-1.5 rounded-md text-2xs font-medium leading-none bg-border-dim text-text-muted">
                  {wf.source === 'markdown' ? 'MD' : 'JSON'}
                </span>
                <Button
                  className="ml-auto"
                  size="small"
                  type="primary"
                  onClick={async () => {
                    const r = await window.electronAPI?.workflow?.run({
                      workflowId: wf.id,
                      projectRoot: projectPath!,
                    });
                    if (r?.ok) message.success(t('settings.workflowStarted', { id: r.data?.runId ?? '' }));
                    else message.error(r?.error || t('settings.startFailed'));
                    const runs = await window.electronAPI?.workflow?.runs();
                    setWorkflowRuns(runs?.ok && runs.data ? runs.data : []);
                  }}
                >
                  {t('settings.run')}
                </Button>
              </div>
              {wf.description && <div className="mt-1 text-xs text-text-muted">{wf.description}</div>}
              <div className="mt-1 text-2xs text-text-faint truncate">{wf.steps.map((s) => s.name).join(' → ')}</div>
            </li>
          ))}
        </ul>
      )}
      {workflowRuns.length > 0 && (
        <div className="mt-4">
          <div className="text-sm font-semibold text-text-primary mb-1">{t('settings.recentRuns')}</div>
          <ul className="list-none m-0 p-0 flex flex-col gap-1">
            {workflowRuns.slice(0, 10).map((run) => (
              <li
                key={run.runId}
                className="flex items-center gap-2 text-xs text-text-secondary px-2 py-2 rounded-md bg-[var(--color-bg-secondary)]"
              >
                <span className="font-mono">{run.runId}</span>
                <span className="truncate">{run.workflowName}</span>
                <span className="ml-auto text-2xs text-text-muted">{run.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3 text-xs text-text-muted leading-[1.6]">
        {t('settings.workflowFormat', { ref: '{{stepId.result}}' })}
      </div>
    </>
  );
}

export function SettingsConnectionsPane() {
  const t = useT();
  const [sshConnections, setSshConnections] = useState<
    {
      id: string;
      name: string;
      host: string;
      port: number;
      username: string;
      keyPath?: string;
      useAgent?: boolean;
      createdAt: number;
    }[]
  >([]);
  const [sshForm, setSshForm] = useState({
    name: '',
    host: '',
    port: '22',
    username: 'root',
    keyPath: '',
    useAgent: false,
  });
  const [sshTesting, setSshTesting] = useState(false);

  useEffect(() => {
    window.electronAPI?.ssh
      ?.list()
      .then((r) => setSshConnections(r.ok && r.data ? r.data : []))
      .catch(() => setSshConnections([]));
  }, []);

  return (
    <>
      <SettingsPaneHeader title={t('settings.item.connections')} description={t('settings.connectionsDesc')} />
      <div className="flex flex-col gap-2 mb-3">
        <div className="grid grid-cols-2 gap-2">
          <Input
            placeholder={t('settings.sshName')}
            value={sshForm.name}
            onChange={(e) => setSshForm({ ...sshForm, name: e.target.value })}
          />
          <Input
            placeholder={t('settings.sshHost')}
            value={sshForm.host}
            onChange={(e) => setSshForm({ ...sshForm, host: e.target.value })}
          />
          <Input
            placeholder={t('settings.sshPort')}
            value={sshForm.port}
            onChange={(e) => setSshForm({ ...sshForm, port: e.target.value })}
          />
          <Input
            placeholder={t('settings.sshUser')}
            value={sshForm.username}
            onChange={(e) => setSshForm({ ...sshForm, username: e.target.value })}
          />
          <Input
            placeholder={t('settings.sshKeyPath')}
            value={sshForm.keyPath}
            onChange={(e) => setSshForm({ ...sshForm, keyPath: e.target.value })}
            className="col-span-2"
          />
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={sshForm.useAgent}
              onChange={(e) => setSshForm({ ...sshForm, useAgent: e.target.checked })}
            />
            SSH Agent
          </label>
          <Button
            size="small"
            loading={sshTesting}
            onClick={async () => {
              if (!sshForm.host.trim()) {
                message.warning(t('settings.needHost'));
                return;
              }
              setSshTesting(true);
              const r = await window.electronAPI?.ssh.test({
                host: sshForm.host.trim(),
                port: Number(sshForm.port) || 22,
                username: sshForm.username || 'root',
                keyPath: sshForm.keyPath || undefined,
                useAgent: sshForm.useAgent,
              });
              setSshTesting(false);
              if (r?.ok) message.success(t('settings.connected', { out: r.data?.output || '' }));
              else message.error(r?.error || t('settings.connectFailed'));
            }}
          >
            {t('settings.testConnection')}
          </Button>
          <Button
            size="small"
            type="primary"
            onClick={async () => {
              const r = await window.electronAPI?.ssh.save({
                name: sshForm.name || sshForm.host,
                host: sshForm.host.trim(),
                port: Number(sshForm.port) || 22,
                username: sshForm.username || 'root',
                keyPath: sshForm.keyPath || undefined,
                useAgent: sshForm.useAgent,
              });
              if (r?.ok) {
                message.success(t('settings.saved'));
                setSshConnections(r.data || []);
                setSshForm({ name: '', host: '', port: '22', username: 'root', keyPath: '', useAgent: false });
              } else message.error(r?.error || t('settings.saveFailed'));
            }}
          >
            {t('settings.saveConnection')}
          </Button>
        </div>
      </div>
      {sshConnections.length === 0 ? (
        <InlineEmpty description={t('settings.noSsh')} compact />
      ) : (
        <ul className="list-none m-0 p-0 flex flex-col gap-2">
          {sshConnections.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--color-bg-secondary)]">
              <span className="text-sm font-medium text-text-primary">{c.name}</span>
              <span className="text-2xs text-text-muted font-mono">
                {c.username}@{c.host}:{c.port}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <Button
                  size="small"
                  onClick={async () => {
                    const r = await window.electronAPI?.ssh.test(c);
                    if (r?.ok) message.success(t('settings.connected', { out: r.data?.output || '' }));
                    else message.error(r?.error || t('settings.connectFailed'));
                  }}
                >
                  {t('settings.test')}
                </Button>
                <Button
                  size="small"
                  danger
                  onClick={async () => {
                    const r = await window.electronAPI?.ssh.remove(c.id);
                    if (r?.ok) {
                      message.success(t('settings.deleted'));
                      setSshConnections(r.data || []);
                    } else message.error(r?.error || t('settings.deleteFailed'));
                  }}
                >
                  {t('sidebar.delete')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 text-xs text-text-muted leading-[1.6]">{t('settings.sshHint')}</div>
    </>
  );
}

export function SettingsRulesPane() {
  const t = useT();
  const projectPath = useSettingsStore((s) => s.projectPath);
  const [rulesList, setRulesList] = useState<
    { pattern: string[]; decision: string; justification?: string; source: string }[]
  >([]);

  useEffect(() => {
    window.electronAPI?.rules
      ?.list(projectPath ?? undefined)
      .then((r) => setRulesList(r.ok && r.data ? r.data : []))
      .catch(() => setRulesList([]));
  }, [projectPath]);

  return (
    <>
      <SettingsPaneHeader title={t('settings.item.rules')} description={t('settings.rulesDesc')} />
      {rulesList.length === 0 ? (
        <InlineEmpty description={t('settings.noRulesFiles')} compact />
      ) : (
        <ul className="list-none m-0 p-0 flex flex-col gap-2">
          {rulesList.map((r, i) => (
            <li key={i} className="px-4 py-3 rounded-xl bg-[var(--color-bg-secondary)]">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-text-primary truncate">{r.pattern.join(' ')}</span>
                <span
                  className={`text-2xs px-1.5 rounded-full ${
                    r.decision === 'allow'
                      ? 'bg-[var(--color-success-soft)]'
                      : r.decision === 'deny'
                        ? 'bg-[var(--color-danger-soft)]'
                        : 'bg-[var(--color-primary-soft)]'
                  } text-text-secondary`}
                >
                  {r.decision === 'allow'
                    ? t('settings.ruleAllow')
                    : r.decision === 'deny'
                      ? t('settings.ruleDeny')
                      : t('settings.ruleAsk')}
                </span>
              </div>
              {r.justification && <div className="mt-1 text-xs text-text-muted">{r.justification}</div>}
              <div className="mt-0.5 text-2xs text-text-faint font-mono truncate">{r.source}</div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
