import { create } from 'zustand';
import type { NotificationStore } from '@/types/notifications';

const MAX_ITEMS = 100;

export const useNotificationStore = create<NotificationStore>()((set) => ({
  items: [],

  push: (n) =>
    set((s) => ({
      items: [
        {
          ...n,
          id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: Date.now(),
          read: false,
        },
        ...s.items,
      ].slice(0, MAX_ITEMS),
    })),

  markRead: (id) =>
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? { ...i, read: true } : i)),
    })),

  markAllRead: () =>
    set((s) => ({
      items: s.items.map((i) => ({ ...i, read: true })),
    })),

  remove: (id) =>
    set((s) => ({
      items: s.items.filter((i) => i.id !== id),
    })),

  clear: () => set({ items: [] }),
}));
