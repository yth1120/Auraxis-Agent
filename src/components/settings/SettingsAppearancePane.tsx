import { useRef, useState } from 'react';
import { Button, Segmented, Select, Slider, Switch, message } from 'antd';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useAppStore } from '../../stores/useAppStore';
import { useI18nStore } from '../../i18n';
import SettingItem from './SettingItem';
import { readWallpaperFile } from './SettingsModalConfig';
import { SettingsPaneHeader, SettingsSectionTitle } from './SettingsPanes';

export function SettingsAppearancePane() {
  const t = useT();
  const {
    sidebarGlass,
    setSidebarGlass,
    sidebarGlassSupported,
    sidebarGlassReady,
    aquaGlass,
    setAquaGlass,
    wallpaper,
    setWallpaper,
    alwaysShowMessageActions,
    setAlwaysShowMessageActions,
  } = useSettingsStore();
  const themeMode = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const locale = useI18nStore((s) => s.locale);
  const setLocale = useI18nStore((s) => s.setLocale);
  const wallpaperInputRef = useRef<HTMLInputElement>(null);
  const [wallpaperBusy, setWallpaperBusy] = useState(false);

  const pickWallpaper = async (file?: File) => {
    if (!file) return;
    setWallpaperBusy(true);
    try {
      const dataUrl = await readWallpaperFile(file);
      setWallpaper(dataUrl);
      message.success(t('settings.aquaWallpaper.done'));
    } catch {
      message.error(t('settings.aquaWallpaper.error'));
    } finally {
      setWallpaperBusy(false);
      if (wallpaperInputRef.current) wallpaperInputRef.current.value = '';
    }
  };

  return (
    <>
      <SettingsPaneHeader title={t('settings.item.appearance')} description={t('settings.pane.appearance.desc')} />
      <SettingsSectionTitle>{t('settings.section.language')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.language.label')} description={t('settings.language.desc')} noBorder>
          <Select
            value={locale}
            onChange={(value) => setLocale(value)}
            style={{ width: '100%' }}
            options={[
              { value: 'zh-CN', label: '中文' },
              { value: 'en-US', label: 'English' },
            ]}
          />
        </SettingItem>
      </section>
      <SettingsSectionTitle>{t('settings.section.theme')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.theme.mode')} description={t('settings.theme.mode.desc')} noBorder>
          <Segmented
            value={themeMode}
            onChange={(value) => setTheme(value as 'system' | 'light' | 'dark')}
            block
            options={[
              { value: 'system', label: t('settings.theme.mode.system') },
              { value: 'light', label: t('settings.theme.mode.light') },
              { value: 'dark', label: t('settings.theme.mode.dark') },
            ]}
          />
        </SettingItem>
      </section>
      <SettingsSectionTitle>{t('settings.section.aqua')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.aquaGlass')} description={t('settings.aquaGlass.desc')} noBorder>
          <div className="flex items-center gap-3 w-full">
            <Slider
              className="flex-1 min-w-0"
              min={0}
              max={100}
              step={5}
              value={aquaGlass}
              onChange={setAquaGlass}
              tooltip={{ formatter: (value) => `${value}%` }}
              marks={{ 0: t('settings.aquaGlass.off'), 100: t('settings.aquaGlass.max') }}
            />
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-text-muted">{aquaGlass}%</span>
          </div>
        </SettingItem>
        <SettingItem title={t('settings.aquaWallpaper')} description={t('settings.aquaWallpaper.desc')} noBorder>
          <div className="flex items-center gap-3 w-full">
            {wallpaper ? (
              <img
                src={wallpaper}
                alt=""
                className="w-16 h-10 shrink-0 object-cover rounded-lg border border-[var(--color-border-dim)]"
              />
            ) : (
              <span className="w-16 h-10 shrink-0 rounded-lg bg-[var(--color-bg-inset)] border border-[var(--color-border-dim)]" />
            )}
            <input
              ref={wallpaperInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => void pickWallpaper(event.target.files?.[0])}
            />
            <div className="flex items-center gap-2">
              <Button size="small" loading={wallpaperBusy} onClick={() => wallpaperInputRef.current?.click()}>
                {t('settings.aquaWallpaper.choose')}
              </Button>
              {wallpaper && (
                <Button size="small" onClick={() => setWallpaper(null)}>
                  {t('settings.aquaWallpaper.remove')}
                </Button>
              )}
            </div>
          </div>
        </SettingItem>
      </section>
      <SettingsSectionTitle>{t('settings.section.sidebar')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem title={t('settings.sidebarGlass')} description={t('settings.sidebarGlass.desc')} noBorder>
          <div className="flex items-center gap-3 w-full">
            <Slider
              className="flex-1 min-w-0"
              min={0}
              max={100}
              step={5}
              value={sidebarGlass}
              onChange={setSidebarGlass}
              disabled={!sidebarGlassSupported || !sidebarGlassReady}
              tooltip={{ formatter: (value) => `${value}%` }}
              marks={{ 0: t('settings.sidebarGlass.off'), 100: t('settings.sidebarGlass.max') }}
            />
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-text-muted">{sidebarGlass}%</span>
          </div>
          {!sidebarGlassSupported && (
            <div className="mt-1.5 text-2xs text-text-faint">{t('settings.sidebarGlass.unsupported')}</div>
          )}
          {sidebarGlassSupported && !sidebarGlassReady && (
            <div className="mt-1.5 text-2xs text-warning">{t('settings.sidebarGlass.restart')}</div>
          )}
        </SettingItem>
      </section>
      <SettingsSectionTitle>{t('settings.section.messages')}</SettingsSectionTitle>
      <section className="mb-2">
        <SettingItem
          title={t('settings.showMessageActions')}
          description={t('settings.showMessageActions.desc')}
          noBorder
        >
          <Switch checked={alwaysShowMessageActions} onChange={setAlwaysShowMessageActions} />
        </SettingItem>
      </section>
    </>
  );
}
