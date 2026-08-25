import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { KEY_BINDINGS, type KeyBinding } from '../constants/keybindings';

export interface KeybindingsStore {
  overrides: Record<number, KeyBinding>;
  setOverride: (index: number, binding: KeyBinding) => void;
  clearOverrides: () => void;
  getActive: () => KeyBinding[];
}

export const useKeybindingsStore = create<KeybindingsStore>()(
  persist(
    (set, get) => ({
      overrides: {},

      setOverride: (index, binding) => set((s) => ({ overrides: { ...s.overrides, [index]: binding } })),

      clearOverrides: () => set({ overrides: {} }),

      getActive: () => {
        const { overrides } = get();
        return KEY_BINDINGS.map((def, i) => overrides[i] || def);
      },
    }),
    {
      name: 'auraxis_keybindings',
      partialize: (s) => ({ overrides: s.overrides }),
    },
  ),
);
