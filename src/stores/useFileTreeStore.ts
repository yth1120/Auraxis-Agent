import { errorText } from '../../electron/errors';
import { create } from 'zustand';
import type { DirectoryEntry } from '../../electron/types';
import type { FileActivity } from '../types/chat';

export interface FileTreeStore {
  /** The fully expanded file tree root node (null when not loaded) */
  tree: DirectoryEntry | null;
  /** Whether a fetch is in progress */
  loading: boolean;
  /** Last error message if fetch failed */
  error: string | null;
  /** Set of expanded directory paths */
  expandedPaths: Set<string>;
  /** The project root path this tree was fetched for */
  projectRoot: string | null;
  /** Per-file agent activity → state-aware tree badges (keyed by absolute path). */
  fileStatus: Record<string, FileActivity>;

  fetchTree: (projectRoot: string) => Promise<void>;
  toggleExpand: (dirPath: string) => void;
  expandToPath: (filePath: string) => void;
  setFileStatus: (filePath: string, activity: FileActivity) => void;
  clearFileStatus: (filePath: string) => void;
  clear: () => void;
}

export const useFileTreeStore = create<FileTreeStore>()((set) => ({
  tree: null,
  loading: false,
  error: null,
  expandedPaths: new Set(),
  projectRoot: null,
  fileStatus: {},

  setFileStatus: (filePath, activity) => set((s) => ({ fileStatus: { ...s.fileStatus, [filePath]: activity } })),

  clearFileStatus: (filePath) =>
    set((s) => {
      if (!(filePath in s.fileStatus)) return s;
      const next = { ...s.fileStatus };
      delete next[filePath];
      return { fileStatus: next };
    }),

  fetchTree: async (projectRoot: string) => {
    if (!projectRoot) return;
    set({ loading: true, error: null, projectRoot });

    try {
      const result = await window.electronAPI?.project.getTree(projectRoot);
      if (result?.ok && result.data) {
        // Auto-expand first level of the tree
        const expanded = new Set<string>();
        if (result.data.children) {
          for (const child of result.data.children) {
            if (child.isDirectory) expanded.add(child.path);
          }
        }

        set({ tree: result.data, loading: false, expandedPaths: expanded });
      } else {
        set({ error: result?.error || '获取文件树失败', loading: false });
      }
    } catch (err: unknown) {
      set({ error: errorText(err) || '获取文件树失败', loading: false });
    }
  },

  toggleExpand: (dirPath: string) =>
    set((s) => {
      const next = new Set(s.expandedPaths);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return { expandedPaths: next };
    }),

  expandToPath: (filePath: string) =>
    set((s) => {
      // Expand all ancestor directories of the given file path
      const next = new Set(s.expandedPaths);
      const sep = filePath.includes('\\') ? '\\' : '/';
      const parts = filePath.split(sep);
      let current = '';
      for (let i = 0; i < parts.length - 1; i++) {
        current = current ? `${current}${sep}${parts[i]}` : parts[i];
        // On Windows, root might be "C:" — skip empty segments
        if (current) next.add(current);
      }
      return { expandedPaths: next };
    }),

  clear: () =>
    set({ tree: null, loading: false, error: null, expandedPaths: new Set(), projectRoot: null, fileStatus: {} }),
}));

// ── Auto-refetch when fileTreeVersion changes ──────────────
let _prevVersion = 0;

import { useAppStore } from './useAppStore';
import { useSettingsStore } from './useSettingsStore';

useAppStore.subscribe((state) => {
  if (state.fileTreeVersion !== _prevVersion) {
    _prevVersion = state.fileTreeVersion;
    const store = useFileTreeStore.getState();
    const projectRoot = store.projectRoot || useSettingsStore.getState().projectPath;
    if (projectRoot) {
      store.fetchTree(projectRoot);
    }
  }
});

// ── Auto-fetch when project path is set/changed ────────────
let _prevProjectPath: string | null = null;

// Check project path periodically (settings store is persistent, may load async)
const checkProjectPath = () => {
  const currentPath = useSettingsStore.getState().projectPath;
  if (currentPath && currentPath !== _prevProjectPath) {
    _prevProjectPath = currentPath;
    const fileStore = useFileTreeStore.getState();
    if (!fileStore.tree || fileStore.projectRoot !== currentPath) {
      fileStore.fetchTree(currentPath);
    }
  }
};

// Check on module load (after stores hydrate from localStorage)
setTimeout(checkProjectPath, 500);

// Also listen to settings store changes
useSettingsStore.subscribe((state) => {
  if (state.projectPath && state.projectPath !== _prevProjectPath) {
    _prevProjectPath = state.projectPath;
    useFileTreeStore.getState().fetchTree(state.projectPath);
  }
});
