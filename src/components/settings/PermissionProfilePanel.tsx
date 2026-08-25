import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Select, message } from 'antd';
import { Plus as PlusOutlined, MinusCircle as MinusCircleOutlined } from '@/components/common/icons';
import SettingItem from './SettingItem';
import type { PermissionProfile } from '../../types/electron-api';
import { useT, type I18nKey } from '../../i18n';

const BUILTIN_FALLBACK: PermissionProfile[] = [
  {
    id: 'standard',
    name: 'profile.standard',
    description: 'profile.standardDesc',
    builtin: true,
    toolPolicy: 'ask',
    fileScopes: [{ pattern: '**', access: 'write' }],
    networkScopes: [{ pattern: '*', access: 'allow' }],
  },
  {
    id: 'readonly',
    name: 'profile.readonly',
    description: 'profile.readonlyDesc',
    builtin: true,
    toolPolicy: 'ask',
    fileScopes: [{ pattern: '**', access: 'read' }],
    networkScopes: [{ pattern: '*', access: 'allow' }],
  },
  {
    id: 'sandbox',
    name: 'profile.sandbox',
    description: 'profile.sandboxDesc',
    builtin: true,
    toolPolicy: 'auto',
    fileScopes: [{ pattern: '**', access: 'write' }],
    networkScopes: [{ pattern: '*', access: 'deny' }],
  },
];

const FILE_ACCESS_LABEL: Record<string, I18nKey> = {
  read: 'profile.fileAccess.read',
  write: 'profile.fileAccess.write',
  deny: 'profile.fileAccess.deny',
};
const NET_ACCESS_LABEL: Record<string, I18nKey> = { allow: 'profile.netAccess.allow', deny: 'profile.netAccess.deny' };
const POLICY_LABEL: Record<string, I18nKey> = {
  ask: 'profile.policy.ask',
  plan: 'profile.policy.plan',
  auto: 'profile.policy.auto',
};
const BUILTIN_NAME_KEY: Record<string, I18nKey> = {
  standard: 'profile.standard',
  readonly: 'profile.readonly',
  sandbox: 'profile.sandbox',
};
const BUILTIN_DESC_KEY: Record<string, I18nKey> = {
  standard: 'profile.standardDesc',
  readonly: 'profile.readonlyDesc',
  sandbox: 'profile.sandboxDesc',
};

const fileAccessOptions = Object.entries(FILE_ACCESS_LABEL).map(([value, label]) => ({ value, label }));
const netAccessOptions = Object.entries(NET_ACCESS_LABEL).map(([value, label]) => ({ value, label }));
const policyOptions = Object.entries(POLICY_LABEL).map(([value, label]) => ({ value, label }));

export default function PermissionProfilePanel() {
  const t = useT();
  const [profiles, setProfiles] = useState<PermissionProfile[]>(BUILTIN_FALLBACK);
  const [activeId, setActiveId] = useState('standard');

  useEffect(() => {
    window.electronAPI?.permissionProfile
      ?.list()
      .then((r) => {
        if (r?.ok && r.data) {
          // Built-in tiers are surfaced here too: the composer presets align
          // with standard/readonly, and sandbox (network-off) stays reachable
          // as a named profile layered on top of the selected preset.
          const data = r.data;
          const visible = data.profiles;
          const nextActive = visible.some((p) => p.id === data.activeId) ? data.activeId : 'standard';
          setProfiles(visible);
          setActiveId(nextActive);
          if (nextActive !== data.activeId) {
            window.electronAPI?.permissionProfile
              ?.save(
                visible.filter((p) => !p.builtin),
                nextActive,
              )
              .catch(() => message.error(t('profile.saveFailed')));
          }
        }
      })
      .catch(() => {
        /* keep built-in fallback */
      });
  }, [t]);

  const persist = useCallback(
    (next: PermissionProfile[], nextActive: string) => {
      setProfiles(next);
      setActiveId(nextActive);
      window.electronAPI?.permissionProfile
        ?.save(
          next.filter((p) => !p.builtin),
          nextActive,
        )
        .catch(() => message.error(t('profile.saveFailed')));
    },
    [t],
  );

  const active = profiles.find((p) => p.id === activeId) ?? profiles[0];

  const updateProfile = useCallback(
    (id: string, patch: Partial<PermissionProfile>) => {
      const next = profiles.map((p) => (p.id === id ? { ...p, ...patch } : p));
      persist(next, activeId);
    },
    [profiles, activeId, persist],
  );

  const updateFileScope = (id: string, idx: number, patch: Partial<PermissionProfile['fileScopes'][number]>) => {
    const next = profiles.map((p) =>
      p.id !== id ? p : { ...p, fileScopes: p.fileScopes.map((s, i) => (i === idx ? { ...s, ...patch } : s)) },
    );
    persist(next, activeId);
  };

  const removeFileScope = (id: string, idx: number) => {
    const next = profiles.map((p) =>
      p.id !== id ? p : { ...p, fileScopes: p.fileScopes.filter((_, i) => i !== idx) },
    );
    persist(next, activeId);
  };

  const addFileScope = (id: string) => {
    const next = profiles.map((p) =>
      p.id !== id ? p : { ...p, fileScopes: [...p.fileScopes, { pattern: '', access: 'write' as const }] },
    );
    persist(next, activeId);
  };

  const updateNetScope = (id: string, idx: number, patch: Partial<PermissionProfile['networkScopes'][number]>) => {
    const next = profiles.map((p) =>
      p.id !== id ? p : { ...p, networkScopes: p.networkScopes.map((s, i) => (i === idx ? { ...s, ...patch } : s)) },
    );
    persist(next, activeId);
  };

  const removeNetScope = (id: string, idx: number) => {
    const next = profiles.map((p) =>
      p.id !== id ? p : { ...p, networkScopes: p.networkScopes.filter((_, i) => i !== idx) },
    );
    persist(next, activeId);
  };

  const addNetScope = (id: string) => {
    const next = profiles.map((p) =>
      p.id !== id ? p : { ...p, networkScopes: [...p.networkScopes, { pattern: '', access: 'deny' as const }] },
    );
    persist(next, activeId);
  };

  const createCustom = () => {
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const profile: PermissionProfile = {
      id,
      name: t('profile.custom'),
      toolPolicy: 'ask',
      fileScopes: [{ pattern: '**', access: 'write' }],
      networkScopes: [{ pattern: '*', access: 'allow' }],
    };
    persist([...profiles, profile], id);
    message.success(t('profile.created'));
  };

  const deleteCustom = (id: string) => {
    // Only reset the active profile if the deleted one was active — deleting
    // a non-active custom profile must not silently switch the user off it.
    const nextActive = activeId === id ? 'standard' : activeId;
    persist(
      profiles.filter((p) => p.id !== id),
      nextActive,
    );
    message.success(t('profile.deleted'));
  };

  const scopeChips = (items: { pattern: string; access: string }[], label: Record<string, I18nKey>) => (
    <div className="flex flex-wrap gap-1.5">
      {items.map((s, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 h-5 px-2 rounded-full bg-border-dim text-2xs text-text-secondary"
        >
          <code className="font-mono">{s.pattern || '?'}</code>
          <span className="text-text-muted">{label[s.access] ? t(label[s.access]) : s.access}</span>
        </span>
      ))}
    </div>
  );

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold text-text-primary">{t('profile.title')}</span>
        <Button size="small" icon={<PlusOutlined />} onClick={createCustom}>
          {t('profile.newCustom')}
        </Button>
      </div>
      <SettingItem
        title={t('profile.current')}
        description={active?.builtin ? t(BUILTIN_DESC_KEY[active.id] ?? 'profile.standardDesc') : active?.description}
      >
        <Select
          value={activeId}
          onChange={(v) => persist(profiles, v)}
          style={{ width: '100%' }}
          options={profiles.map((p) => ({
            value: p.id,
            label: p.builtin ? t(BUILTIN_NAME_KEY[p.id] ?? 'profile.standard') : p.name,
          }))}
          getPopupContainer={(t) => t.parentElement || document.body}
        />
      </SettingItem>

      {active?.builtin ? (
        <div className="flex flex-col gap-2.5 pt-1">
          <div className="flex flex-col gap-1">
            <span className="text-2xs text-text-muted">{t('profile.fileRules')}</span>
            {scopeChips(active.fileScopes, FILE_ACCESS_LABEL)}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-2xs text-text-muted">{t('profile.netRules')}</span>
            {scopeChips(active.networkScopes, NET_ACCESS_LABEL)}
          </div>
          <p className="m-0 text-2xs text-text-faint">{t('profile.builtinHint')}</p>
        </div>
      ) : active ? (
        <div className="flex flex-col gap-3 pt-1">
          <SettingItem title={t('profile.name')} noBorder>
            <Input
              value={active.name}
              onChange={(e) => updateProfile(active.id, { name: e.target.value })}
              maxLength={40}
            />
          </SettingItem>
          <SettingItem title={t('profile.policy')} description={t('profile.policy.desc')} noBorder>
            <Select
              value={active.toolPolicy}
              onChange={(v) => updateProfile(active.id, { toolPolicy: v })}
              style={{ width: '100%' }}
              options={policyOptions.map((o) => ({ value: o.value, label: t(o.label as I18nKey) }))}
              getPopupContainer={(t) => t.parentElement || document.body}
            />
          </SettingItem>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-text-primary">{t('profile.fileRulesHint')}</span>
            {active.fileScopes.map((s, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  className="flex-1"
                  value={s.pattern}
                  placeholder="src/**"
                  onChange={(e) => updateFileScope(active.id, i, { pattern: e.target.value })}
                />
                <Select
                  className="w-[96px]"
                  value={s.access}
                  onChange={(v) => updateFileScope(active.id, i, { access: v })}
                  options={fileAccessOptions.map((o) => ({ value: o.value, label: t(o.label as I18nKey) }))}
                />
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<MinusCircleOutlined />}
                  onClick={() => removeFileScope(active.id, i)}
                />
              </div>
            ))}
            <Button size="small" icon={<PlusOutlined />} onClick={() => addFileScope(active.id)}>
              {t('profile.addFileRule')}
            </Button>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-text-primary">{t('profile.netRulesHint')}</span>
            {active.networkScopes.map((s, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  className="flex-1"
                  value={s.pattern}
                  placeholder="api.example.com"
                  onChange={(e) => updateNetScope(active.id, i, { pattern: e.target.value })}
                />
                <Select
                  className="w-[96px]"
                  value={s.access}
                  onChange={(v) => updateNetScope(active.id, i, { access: v })}
                  options={netAccessOptions.map((o) => ({ value: o.value, label: t(o.label as I18nKey) }))}
                />
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<MinusCircleOutlined />}
                  onClick={() => removeNetScope(active.id, i)}
                />
              </div>
            ))}
            <Button size="small" icon={<PlusOutlined />} onClick={() => addNetScope(active.id)}>
              {t('profile.addNetRule')}
            </Button>
          </div>

          <div className="flex justify-end">
            <Button danger size="small" onClick={() => deleteCustom(active.id)}>
              {t('profile.deleteThis')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
