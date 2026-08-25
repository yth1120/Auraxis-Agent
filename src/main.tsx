import React from 'react';
import ReactDOM from 'react-dom/client';
import { IconContext } from '@/components/common/icons';
import App from './App';
import { hydrateProjectStore, startProjectPersistence } from './stores/useProjectStore';
import type { ProjectGlobalState } from '../electron/contracts/project';
import '@fontsource-variable/inter';
import './styles/app.css';
import 'allotment/dist/style.css';

async function bootstrapProjectRegistry(): Promise<void> {
  let state: ProjectGlobalState | null = null;
  try {
    const r = await window.electronAPI?.project?.loadGlobalState?.();
    if (r?.ok && r.data) state = r.data;
  } catch {
    // 读取失败时保持空注册表，不阻塞启动。
  }

  // 旧版 zustand persist 格式：{ state: {...} }，迁移到磁盘后移除。
  try {
    const raw = localStorage.getItem('auraxis-projects');
    if (raw) {
      const parsed = JSON.parse(raw);
      const legacy = parsed?.state;
      if (legacy && Array.isArray(legacy.projects)) {
        const base: ProjectGlobalState = state ?? {
          projects: [],
          currentProjectId: null,
          view: { groupBy: 'workspace', orderBy: 'manual' },
          workspaceOrder: [],
          sessionOrder: {},
        };
        const diskPaths = new Set(base.projects.map((p) => p.path));
        const mergedProjects = [
          ...base.projects,
          ...legacy.projects.filter(
            (p: { path?: unknown }) => p && typeof p.path === 'string' && !diskPaths.has(p.path),
          ),
        ];
        state = {
          ...base,
          projects: mergedProjects,
          sessionOrder: { ...(legacy.sessionOrder ?? {}), ...(base.sessionOrder ?? {}) },
        };
        localStorage.removeItem('auraxis-projects');
        void window.electronAPI?.project?.saveGlobalState?.(state)?.catch(() => {});
      }
    }
  } catch {
    // 损坏的旧数据直接忽略。
  }

  hydrateProjectStore(state);
  startProjectPersistence();
}

void bootstrapProjectRegistry().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {/* Global icon defaults. size:'1em' is REQUIRED — Phosphor has no built-in
          size default, so without it icons render with no width/height and balloon
          to intrinsic size. 1em makes every icon scale to its surrounding text. */}
      <IconContext.Provider value={{ size: '1em', strokeWidth: 1.5 }}>
        <App />
      </IconContext.Provider>
    </React.StrictMode>,
  );
});
