import { useEffect, useState } from 'react';
import { Button, Input, message } from 'antd';
import { ChatTeardropDots, Folder, FileText } from '@/components/common/icons';
import { useT } from '../../i18n';

type Kind = 'slack' | 'drive' | 'notion';

const KINDS: Kind[] = ['slack', 'drive', 'notion'];

const KIND_META: Record<Kind, { icon: React.ReactNode; nameKey: string; descKey: string; placeholder: string }> = {
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
};

export default function ConnectorsPane() {
  const t = useT();
  const [tokens, setTokens] = useState<Record<Kind, string>>({ slack: '', drive: '', notion: '' });
  const [configured, setConfigured] = useState<Record<Kind, boolean>>({ slack: false, drive: false, notion: false });
  const [testing, setTesting] = useState<Kind | null>(null);
  const [saving, setSaving] = useState<Kind | null>(null);
  const [messages, setMessages] = useState<Record<Kind, string>>({ slack: '', drive: '', notion: '' });

  useEffect(() => {
    window.electronAPI?.connectors
      ?.status()
      .then((r) => {
        if (!r?.ok || !r.data) return;
        const next: Record<Kind, boolean> = { slack: false, drive: false, notion: false };
        for (const s of r.data) next[s.kind] = s.configured;
        setConfigured(next);
      })
      .catch(() => {
        /* keep defaults */
      });
  }, []);

  const saveToken = async (kind: Kind) => {
    setSaving(kind);
    try {
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
                  <div className="text-sm font-semibold text-text-primary">{t(meta.nameKey as any)}</div>
                  <div className="text-xs text-text-muted leading-[1.5]">{t(meta.descKey as any)}</div>
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
              {messages[kind] && <div className="mt-2 text-xs text-text-muted leading-[1.5]">{messages[kind]}</div>}
            </section>
          );
        })}
      </div>
      <div className="mt-4 text-xs text-text-muted leading-[1.6]">{t('settings.connectors.hint')}</div>
    </div>
  );
}
