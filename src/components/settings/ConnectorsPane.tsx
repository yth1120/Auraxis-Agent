import { useEffect, useState } from 'react';
import { Button, Input, Select, message } from 'antd';
import { ChatTeardropDots, Folder, FileText, Globe } from '@/components/common/icons';
import { useT, type I18nKey } from '../../i18n';

type Kind = 'slack' | 'drive' | 'notion' | 'lark';

const KINDS: Kind[] = ['slack', 'drive', 'notion', 'lark'];

const KIND_META: Record<Kind, { icon: React.ReactNode; nameKey: I18nKey; descKey: I18nKey; placeholder: string }> = {
  slack: {
    icon: <ChatTeardropDots size={18} />,
    nameKey: 'settings.connectors.slack',
    descKey: 'settings.connectors.slack.desc',
    placeholder: 'xoxb-…',
  },
  drive: {
    icon: <Folder size={18} />,
    nameKey: 'settings.connectors.drive',
    descKey: 'settings.connectors.drive.desc',
    placeholder: 'ya29.…',
  },
  notion: {
    icon: <FileText size={18} />,
    nameKey: 'settings.connectors.notion',
    descKey: 'settings.connectors.notion.desc',
    placeholder: 'secret_…',
  },
  lark: {
    icon: <Globe size={18} />,
    nameKey: 'settings.connectors.lark',
    descKey: 'settings.connectors.lark.desc',
    placeholder: 'cli_…',
  },
};

interface LarkForm {
  appId: string;
  appSecret: string;
  domain: string;
  tools: string;
}

const DEFAULT_LARK: LarkForm = {
  appId: '',
  appSecret: '',
  domain: 'https://open.feishu.cn',
  tools: 'preset.light',
};

export default function ConnectorsPane() {
  const t = useT();
  const [tokens, setTokens] = useState<Record<Kind, string>>({
    slack: '',
    drive: '',
    notion: '',
    lark: '',
  });
  const [lark, setLark] = useState<LarkForm>(DEFAULT_LARK);
  const [configured, setConfigured] = useState<Record<Kind, boolean>>({
    slack: false,
    drive: false,
    notion: false,
    lark: false,
  });
  const [testing, setTesting] = useState<Kind | null>(null);
  const [saving, setSaving] = useState<Kind | null>(null);
  const [messages, setMessages] = useState<Record<Kind, string>>({
    slack: '',
    drive: '',
    notion: '',
    lark: '',
  });

  useEffect(() => {
    window.electronAPI?.connectors
      ?.status()
      .then((r) => {
        if (!r?.ok || !r.data) return;
        const next: Record<Kind, boolean> = { slack: false, drive: false, notion: false, lark: false };
        for (const s of r.data) next[s.kind] = s.configured;
        setConfigured(next);
      })
      .catch(() => {
        /* keep defaults */
      });
    window.electronAPI?.connectors
      ?.getLark?.()
      .then((r) => {
        if (!r?.ok || !r.data) return;
        const config = r.data;
        setLark((prev) => ({
          ...prev,
          appId: config.appId ?? prev.appId,
          domain: config.domain || prev.domain,
          tools: config.tools || prev.tools,
        }));
      })
      .catch(() => {
        /* keep defaults */
      });
  }, []);

  const saveToken = async (kind: Kind) => {
    setSaving(kind);
    try {
      if (kind === 'lark') {
        if (!lark.appId.trim() || !lark.appSecret.trim()) {
          message.warning(t('settings.connectors.lark.required'));
          return;
        }
        const r = await window.electronAPI?.connectors?.setLark({
          appId: lark.appId,
          appSecret: lark.appSecret,
          domain: lark.domain,
          tools: lark.tools,
        });
        if (r?.ok) {
          message.success(t('settings.saved'));
          setConfigured((c) => ({ ...c, lark: true }));
          setMessages((m) => ({ ...m, lark: '' }));
        } else {
          message.error(r?.error || t('settings.saveFailed'));
        }
        return;
      }

      const r = await window.electronAPI?.connectors?.setToken(kind, tokens[kind]);
      if (r?.ok) {
        message.success(t('settings.saved'));
        setConfigured((c) => ({ ...c, [kind]: true }));
        setMessages((m) => ({ ...m, [kind]: '' }));
      } else {
        message.error(r?.error || t('settings.saveFailed'));
      }
    } finally {
      setSaving(null);
    }
  };

  const test = async (kind: Kind) => {
    setTesting(kind);
    try {
      const r = await window.electronAPI?.connectors?.test(kind);
      setMessages((m) => ({
        ...m,
        [kind]: r?.ok && r.data ? r.data.message : r?.error || t('settings.connectFailed'),
      }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="m-0 text-lg font-semibold text-text-primary tracking-[-0.01em]">
          {t('settings.item.connectors')}
        </h2>
        <p className="m-0 mt-1 text-xs text-text-muted leading-[1.6]">{t('settings.connectors.desc')}</p>
      </div>
      <div className="flex flex-col gap-3">
        {KINDS.map((kind) => {
          const meta = KIND_META[kind];
          const ok = configured[kind];
          return (
            <section
              key={kind}
              className="px-4 py-3 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)]"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--color-bg-primary)] text-text-secondary">
                  {meta.icon}
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text-primary">{t(meta.nameKey)}</div>
                  <div className="text-xs text-text-muted leading-[1.5]">{t(meta.descKey)}</div>
                </div>
                <span
                  className={`ml-auto inline-flex items-center h-5 px-2 rounded-full text-2xs font-medium ${
                    ok
                      ? 'bg-[var(--color-success-soft)] text-text-secondary'
                      : 'bg-[var(--color-border-dim)] text-text-muted'
                  }`}
                >
                  {ok ? t('settings.connectors.configured') : t('settings.connectors.notConfigured')}
                </span>
              </div>
              {kind === 'lark' ? (
                <div className="mt-3 flex flex-col gap-2">
                  <Input
                    value={lark.appId}
                    onChange={(e) => setLark((s) => ({ ...s, appId: e.target.value }))}
                    placeholder={t('settings.connectors.lark.appId')}
                    autoComplete="off"
                  />
                  <Input.Password
                    value={lark.appSecret}
                    onChange={(e) => setLark((s) => ({ ...s, appSecret: e.target.value }))}
                    placeholder={t('settings.connectors.lark.appSecret')}
                    autoComplete="off"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Select
                      value={lark.domain}
                      onChange={(value) => setLark((s) => ({ ...s, domain: value }))}
                      options={[
                        { label: t('settings.connectors.lark.domainFeishu'), value: 'https://open.feishu.cn' },
                        { label: t('settings.connectors.lark.domainLark'), value: 'https://open.larksuite.com' },
                      ]}
                    />
                    <Select
                      value={lark.tools}
                      onChange={(value) => setLark((s) => ({ ...s, tools: value }))}
                      options={[
                        { label: t('settings.connectors.lark.toolsLight'), value: 'preset.light' },
                        { label: t('settings.connectors.lark.toolsIM'), value: 'preset.im.default' },
                        { label: t('settings.connectors.lark.toolsFull'), value: 'preset.default' },
                      ]}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button loading={saving === kind} onClick={() => void saveToken(kind)}>
                      {t('settings.save')}
                    </Button>
                    <Button
                      loading={testing === kind}
                      disabled={!configured[kind] && (!lark.appId.trim() || !lark.appSecret.trim())}
                      onClick={() => void test(kind)}
                    >
                      {t('settings.test')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2">
                  <Input.Password
                    value={tokens[kind]}
                    onChange={(e) => setTokens((s) => ({ ...s, [kind]: e.target.value }))}
                    placeholder={meta.placeholder}
                    autoComplete="off"
                    className="flex-1"
                  />
                  <Button loading={saving === kind} onClick={() => void saveToken(kind)}>
                    {t('settings.save')}
                  </Button>
                  <Button
                    loading={testing === kind}
                    disabled={!configured[kind] && !tokens[kind].trim()}
                    onClick={() => void test(kind)}
                  >
                    {t('settings.test')}
                  </Button>
                </div>
              )}
              {messages[kind] && <div className="mt-2 text-xs text-text-muted leading-[1.5]">{messages[kind]}</div>}
            </section>
          );
        })}
      </div>
      <div className="mt-4 text-xs text-text-muted leading-[1.6]">{t('settings.connectors.hint')}</div>
    </div>
  );
}
