import { useCallback, useEffect, useRef, useState } from 'react';
import { Input, InputNumber, Select, Switch, message } from 'antd';
import SettingItem from './SettingItem';
import { t as i18nT, useT } from '../../i18n';

export interface SchemaField {
  key: string;
  label: string;
  description?: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string | number; label: string }[];
  default?: string | number | boolean;
}

interface SchemaPanelProps {
  title: string;
  description?: string;
  fields: SchemaField[];
}

/**
 * Generic schema-driven settings section. Renders every field from a plain
 * schema object and persists changes through the existing settings IPC, so a
 * new setting is one schema entry instead of hand-written JSX.
 */
export default function SchemaPanel({ title, description, fields }: SchemaPanelProps) {
  const tPanel = useT();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [savedKeys, setSavedKeys] = useState<Record<string, boolean>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    let disposed = false;
    const liveTimers = timers.current;
    window.electronAPI?.settings
      ?.get()
      .then((r) => {
        if (!disposed && r?.ok && r.data) setValues(r.data as Record<string, unknown>);
      })
      .catch(() => {
        /* keep defaults in browser/dev preview */
      });
    return () => {
      disposed = true;
      Object.values(liveTimers).forEach(clearTimeout);
    };
  }, []);

  const update = useCallback((key: string, value: unknown) => {
    setValues((v) => ({ ...v, [key]: value }));
    window.electronAPI?.settings
      ?.set(key, value)
      .then((r) => {
        if (!r?.ok) {
          message.error(r?.error || i18nT('schema.saveFailed', { key }));
          return;
        }
        setSavedKeys((s) => ({ ...s, [key]: true }));
        const t = setTimeout(() => {
          setSavedKeys((s) => ({ ...s, [key]: false }));
          delete timers.current[key];
        }, 1_400);
        timers.current[key] = t;
      })
      .catch(() => message.error(i18nT('schema.saveFailed', { key })));
  }, []);

  const renderControl = (f: SchemaField) => {
    const value = values[f.key] ?? f.default;
    switch (f.type) {
      case 'text':
        return (
          <Input
            value={typeof value === 'string' ? value : ''}
            placeholder={f.placeholder}
            onChange={(e) => update(f.key, e.target.value)}
          />
        );
      case 'number':
        return (
          <InputNumber
            value={typeof value === 'number' ? value : undefined}
            min={f.min}
            max={f.max}
            step={f.step}
            style={{ width: '100%' }}
            onChange={(v) => update(f.key, v ?? null)}
          />
        );
      case 'boolean':
        return <Switch checked={value === true} onChange={(v) => update(f.key, v)} />;
      case 'select':
        return (
          <Select
            value={value}
            style={{ width: '100%' }}
            options={f.options ?? []}
            getPopupContainer={(t) => t.parentElement || document.body}
            onChange={(v) => update(f.key, v)}
          />
        );
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="m-0 text-lg font-semibold text-text-primary tracking-[-0.01em]">{title}</h2>
        {description && <p className="m-0 mt-1 text-xs text-text-muted leading-[1.6]">{description}</p>}
      </div>
      <div>
        {fields.map((f, i) => (
          <SettingItem key={f.key} title={f.label} description={f.description} noBorder={i === fields.length - 1}>
            <div className="flex items-center justify-end gap-2 w-full">
              <span
                className={`text-2xs text-text-muted whitespace-nowrap transition-opacity duration-200 ${savedKeys[f.key] ? 'opacity-100' : 'opacity-0'}`}
              >
                {tPanel('schema.saved')}
              </span>
              {renderControl(f)}
            </div>
          </SettingItem>
        ))}
      </div>
    </div>
  );
}
