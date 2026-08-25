import { useEffect, useState } from 'react';
import { Button, Input, InputNumber, message } from 'antd';
import { Trash, Plus } from '@/components/common/icons';
import { useT } from '../../i18n';

interface CustomModel {
  id: string;
  name: string;
  apiBase: string;
  apiKey?: string;
  maxTokens?: number;
}

const EMPTY: CustomModel = { id: '', name: '', apiBase: '', apiKey: '', maxTokens: undefined };

/** 自定义模型管理：id / 名称 / OpenAI 兼容端点 / Key / 最大输出。密钥经主进程 safeStorage 加密。 */
export default function CustomModelsPane() {
  const t = useT();
  const [models, setModels] = useState<CustomModel[]>([]);
  const [draft, setDraft] = useState<CustomModel>(EMPTY);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await window.electronAPI?.settings.get('customModels');
      const list = r?.ok && Array.isArray(r.data) ? (r.data as CustomModel[]) : [];
      setModels(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async (next: CustomModel[]) => {
    const r = await window.electronAPI?.settings.set('customModels', next);
    if (r?.ok) {
      setModels(next);
      message.success(t('settings.customModels.saved'));
    } else {
      message.error(r?.error || t('settings.customModels.saveFailed'));
    }
  };

  const add = () => {
    if (!draft.id.trim() || !draft.name.trim() || !draft.apiBase.trim()) {
      message.warning(t('settings.customModels.required'));
      return;
    }
    if (models.some((m) => m.id === draft.id.trim())) {
      message.warning(t('settings.customModels.exists'));
      return;
    }
    void save([...models, { ...draft, id: draft.id.trim(), name: draft.name.trim(), apiBase: draft.apiBase.trim() }]);
    setDraft(EMPTY);
  };

  const remove = (id: string) => {
    void save(models.filter((m) => m.id !== id));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-text-muted">{t('settings.customModels.desc')}</p>
      {loading && <div className="text-2xs text-text-faint">{t('settings.customModels.loading')}</div>}

      <div className="grid grid-cols-[1fr_1fr_1.4fr_1fr_1fr_auto] gap-2 items-end">
        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          {t('settings.customModels.id')}
          <Input
            value={draft.id}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            placeholder="my-provider"
            className="!h-8"
          />
        </label>
        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          {t('settings.customModels.name')}
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="My Provider"
            className="!h-8"
          />
        </label>
        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          {t('settings.customModels.apiBase')}
          <Input
            value={draft.apiBase}
            onChange={(e) => setDraft({ ...draft, apiBase: e.target.value })}
            placeholder="https://api.example.com/v1/chat/completions"
            className="!h-8"
          />
        </label>
        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          {t('settings.customModels.apiKey')}
          <Input.Password
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            placeholder={t('settings.customModels.apiKey')}
            className="!h-8"
          />
        </label>
        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          {t('settings.customModels.maxTokens')}
          <InputNumber
            value={draft.maxTokens}
            onChange={(v) => setDraft({ ...draft, maxTokens: v ?? undefined })}
            className="!w-full !h-8"
            min={1024}
            max={384000}
            step={1024}
          />
        </label>
        <Button type="primary" icon={<Plus />} onClick={add}>
          {t('settings.customModels.add')}
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        {models.length === 0 && <div className="text-2xs text-text-faint">{t('settings.customModels.empty')}</div>}
        {models.map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-2 px-3 h-9 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] text-xs"
          >
            <span className="font-mono font-medium text-text-primary truncate max-w-[180px]">{m.id}</span>
            <span className="text-text-secondary truncate max-w-[160px]">{m.name}</span>
            <span className="text-text-faint truncate flex-1">{m.apiBase}</span>
            <span className="text-2xs text-text-faint">
              {m.maxTokens ? `${(m.maxTokens / 1024).toFixed(0)}K` : '—'}
            </span>
            <button
              type="button"
              className="border-none bg-transparent p-0 text-text-muted hover:text-danger cursor-pointer"
              onClick={() => remove(m.id)}
              aria-label={t('settings.customModels.delete')}
            >
              <Trash />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
