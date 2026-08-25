import {
  GearSix,
  PaintBrush,
  Keyboard,
  ChartBar,
  Robot,
  Brain,
  Plugs,
  Blocks,
  ShieldCheck,
  FileText,
  Lightning,
  GitBranch,
  PlugsConnected,
  Info,
  Percent,
  Gauge,
  Key,
  Coins,
  Globe,
} from '@/components/common/icons';
import type { I18nKey } from '../../i18n';
export function readWallpaperFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const img = new Image();
      img.onload = () => {
        try {
          const MAX = 1920;
          const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * scale));
          const h = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('canvas unavailable');
          // JPEG has no alpha — white base keeps PNG transparency from turning black.
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch {
          reject(new Error('encode failed'));
        }
      };
      img.onerror = () => reject(new Error('invalid image'));
      img.src = dataUrl;
    };
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}
/* ── Grouped left navigation (Linear-style) ─────────────── */
export const NAV_GROUPS: { labelKey: I18nKey; items: { key: string; labelKey: I18nKey; icon: React.ReactNode }[] }[] = [
  {
    labelKey: 'settings.nav.general',
    items: [
      { key: 'general', labelKey: 'settings.item.general', icon: <GearSix size={16} /> },
      { key: 'appearance', labelKey: 'settings.item.appearance', icon: <PaintBrush size={16} /> },
      { key: 'keybindings', labelKey: 'settings.item.keybindings', icon: <Keyboard size={16} /> },
    ],
  },
  {
    labelKey: 'settings.nav.modelRuntime',
    items: [
      { key: 'agents', labelKey: 'settings.item.agents', icon: <Robot size={16} /> },
      { key: 'agent-runtime', labelKey: 'settings.item.agentRuntime', icon: <Gauge size={16} /> },
      { key: 'memory', labelKey: 'settings.item.memory', icon: <Brain size={16} /> },
      { key: 'project-rules', labelKey: 'settings.item.projectRules', icon: <FileText size={16} /> },
      { key: 'custom-models', labelKey: 'settings.item.customModels', icon: <PlugsConnected size={16} /> },
      { key: 'connectors', labelKey: 'settings.item.connectors', icon: <Globe size={16} /> },
      { key: 'mcp', labelKey: 'settings.item.mcp', icon: <Plugs size={16} /> },
      { key: 'plugins', labelKey: 'settings.item.plugins', icon: <Blocks size={16} /> },
    ],
  },
  {
    labelKey: 'settings.nav.security',
    items: [
      { key: 'account', labelKey: 'settings.item.account', icon: <Key size={16} /> },
      { key: 'permissions', labelKey: 'settings.item.permissions', icon: <ShieldCheck size={16} /> },
      { key: 'rules', labelKey: 'settings.item.rules', icon: <FileText size={16} /> },
    ],
  },
  {
    labelKey: 'settings.nav.advanced',
    items: [
      { key: 'cost', labelKey: 'settings.item.cost', icon: <Coins size={16} /> },
      { key: 'actions', labelKey: 'settings.item.actions', icon: <Lightning size={16} /> },
      { key: 'workflows', labelKey: 'settings.item.workflows', icon: <GitBranch size={16} /> },
      { key: 'connections', labelKey: 'settings.item.connections', icon: <PlugsConnected size={16} /> },
      { key: 'stats', labelKey: 'settings.item.stats', icon: <ChartBar size={16} /> },
      { key: 'coverage', labelKey: 'settings.item.coverage', icon: <Percent size={16} /> },
    ],
  },
  {
    labelKey: 'settings.nav.about',
    items: [{ key: 'about', labelKey: 'settings.item.about', icon: <Info size={16} /> }],
  },
];
