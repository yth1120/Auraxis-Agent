import { useEffect, useState } from 'react';
import { Button, Modal, Space } from 'antd';
import clsx from 'clsx';
import { useT, keybindingDescKey } from '../../i18n';
import { useKeybindingsStore } from '../../stores/useKeybindingsStore';
import { KEY_BINDINGS, formatBinding, isCtrlOrCmd, type KeyBinding } from '../../constants/keybindings';
import { SettingsPaneHeader } from './SettingsPanes';

export function SettingsKeybindingsPane() {
  const t = useT();
  const overrides = useKeybindingsStore((s) => s.overrides);
  const setOverride = useKeybindingsStore((s) => s.setOverride);
  const clearOverrides = useKeybindingsStore((s) => s.clearOverrides);
  const active = useKeybindingsStore((s) => s.getActive());
  const [recordingIndex, setRecordingIndex] = useState<number | null>(null);

  useEffect(() => {
    if (recordingIndex === null) return;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecordingIndex(null);
        return;
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
      const newBinding: KeyBinding = {
        key: event.key,
        ctrl: isCtrlOrCmd(event) || undefined,
        shift: event.shiftKey || undefined,
        alt: event.altKey || undefined,
        description: KEY_BINDINGS[recordingIndex].description,
        category: KEY_BINDINGS[recordingIndex].category,
      };
      const conflictIndex = active.findIndex(
        (binding, index) =>
          index !== recordingIndex &&
          binding.key === newBinding.key &&
          (binding.ctrl ?? false) === (newBinding.ctrl ?? false) &&
          (binding.shift ?? false) === (newBinding.shift ?? false) &&
          (binding.alt ?? false) === (newBinding.alt ?? false),
      );
      if (conflictIndex >= 0) {
        Modal.confirm({
          title: t('settings.shortcutConflict'),
          content: t('settings.shortcutConflictBody', {
            new: formatBinding(newBinding),
            desc: KEY_BINDINGS[conflictIndex].description,
          }),
          okText: t('settings.overwrite'),
          cancelText: t('common.cancel'),
          onOk: () => {
            setOverride(recordingIndex, newBinding);
            setRecordingIndex(null);
          },
          onCancel: () => setRecordingIndex(null),
        });
      } else {
        setOverride(recordingIndex, newBinding);
        setRecordingIndex(null);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recordingIndex, active, setOverride, t]);

  return (
    <>
      <SettingsPaneHeader title={t('settings.item.keybindings')} description={t('settings.pane.keybindings.desc')} />
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold text-text-primary">{t('settings.bindings')}</span>
        <Button
          size="small"
          onClick={() => {
            Modal.confirm({
              title: t('settings.restoreDefaultConfirmTitle'),
              content: t('settings.restoreDefaultConfirmBody'),
              okText: t('settings.confirm'),
              cancelText: t('common.cancel'),
              onOk: () => clearOverrides(),
            });
          }}
        >
          {t('settings.restoreDefault')}
        </Button>
      </div>
      <div>
        {KEY_BINDINGS.map((definition, index) => {
          const current = active[index];
          const isRecording = recordingIndex === index;
          const isOverridden = overrides[index] !== undefined;
          return (
            <div key={index} className="flex items-center justify-between py-3">
              <span className="text-sm text-text-primary">{t(keybindingDescKey(definition.description))}</span>
              <Space size={8}>
                <span
                  className={clsx(
                    'font-mono text-xs text-text-secondary bg-border-dim px-2 py-[2px] rounded-md',
                    isOverridden && 'text-text-primary bg-primary-soft',
                  )}
                >
                  {formatBinding(current)}
                </span>
                <Button
                  size="small"
                  type={isRecording ? 'primary' : 'default'}
                  onClick={() => setRecordingIndex(isRecording ? null : index)}
                >
                  {isRecording ? t('settings.pressNewKey') : t('settings.rebind')}
                </Button>
              </Space>
            </div>
          );
        })}
      </div>
    </>
  );
}
