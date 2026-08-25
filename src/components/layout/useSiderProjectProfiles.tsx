import { useEffect, useState } from 'react';
import { message } from 'antd';
import type { MenuProps } from 'antd';
import { Check as CheckOutlined } from '@/components/common/icons';
import { useT } from '../../i18n';
import { useProjectStore } from '../../stores/useProjectStore';
import type { PermissionProfile } from '../../types/electron-api';

export function useSiderProjectProfiles() {
  const t = useT();
  const [profiles, setProfiles] = useState<PermissionProfile[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    const pending = window.electronAPI?.permissionProfile?.listProjectProfiles?.();
    if (pending) {
      pending
        .then((result) => {
          if (!alive || !result?.ok || !result.data) return;
          setProfiles(result.data.profiles);
          setOverrides(result.data.overrides ?? {});
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, []);

  const applyProjectProfile = async (path: string, profileId: string | null) => {
    const result = await window.electronAPI?.permissionProfile?.setProjectProfile?.(path, profileId);
    if (!result?.ok) {
      message.error(result?.error || t('sidebar.projectPermissionSaveFailed'));
      return;
    }
    setOverrides((prev) => {
      const next = { ...prev };
      if (profileId) next[path] = profileId;
      else delete next[path];
      return next;
    });
    message.success(t('sidebar.projectPermissionSaved'));
  };

  const projectProfileMenu = (path: string): MenuProps['items'] => {
    const current = overrides[path] ?? null;
    const items: NonNullable<MenuProps['items']> = [
      {
        key: '__global__',
        label: t('sidebar.projectPermissionGlobal'),
        icon: current === null ? <CheckOutlined size={12} className="text-primary" /> : undefined,
      },
      { type: 'divider' },
    ];
    for (const profile of profiles) {
      items.push({
        key: profile.id,
        label: profile.name,
        icon: current === profile.id ? <CheckOutlined size={12} className="text-primary" /> : undefined,
      });
    }
    return items;
  };

  const addProjectWorkspace = async () => {
    const result = await window.electronAPI?.project.selectDirectory();
    if (result?.ok && result.data) {
      const project = useProjectStore.getState().addProject(result.data);
      message.success(t('sidebar.addedWorkspace', { name: project.name }));
    }
  };

  return { projectProfileMenu, applyProjectProfile, addProjectWorkspace };
}
