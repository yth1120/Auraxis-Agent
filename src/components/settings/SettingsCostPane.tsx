import { InputNumber, Space } from 'antd';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/useSettingsStore';
import SettingItem from './SettingItem';
import { SettingsSectionTitle } from './SettingsPanes';

export function SettingsCostPane() {
  const t = useT();
  const { inputPricePerM, outputPricePerM, setInputPricePerM, setOutputPricePerM } = useSettingsStore();
  return (
    <>
      <SettingsSectionTitle>{t('settings.section.cost')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.cost.input')} description={t('settings.cost.input.desc')}>
          <Space.Compact block>
            <InputNumber
              value={inputPricePerM}
              onChange={(value) => setInputPricePerM(Number(value) || 0)}
              min={0}
              step={0.1}
              precision={2}
              style={{ width: '100%' }}
              placeholder="0"
            />
            <span className="inline-flex items-center px-2.5 text-xs text-text-muted bg-[var(--color-bg-inset)] border border-l-0 border-[var(--color-border-dim)]">
              {t('settings.currencyUnit')}
            </span>
          </Space.Compact>
        </SettingItem>
        <SettingItem title={t('settings.cost.output')} description={t('settings.cost.output.desc')} noBorder>
          <Space.Compact block>
            <InputNumber
              value={outputPricePerM}
              onChange={(value) => setOutputPricePerM(Number(value) || 0)}
              min={0}
              step={0.1}
              precision={2}
              style={{ width: '100%' }}
              placeholder="0"
            />
            <span className="inline-flex items-center px-2.5 text-xs text-text-muted bg-[var(--color-bg-inset)] border border-l-0 border-[var(--color-border-dim)]">
              {t('settings.currencyUnit')}
            </span>
          </Space.Compact>
        </SettingItem>
      </section>
    </>
  );
}
