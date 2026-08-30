/** preload-platform.ts — platform/window/auth/file/project renderer bridge. */
import type { ApplyCodePayload } from './contracts/core';
import { invoke, subscribe } from './preload-shared';

export function createPlatformApi() {
  return {
    platform: process.platform,
    homePath: process.env.USERPROFILE || process.env.HOME || '',

    minimize: () => invoke('window:minimize'),
    maximize: () => invoke('window:maximize'),
    close: () => invoke('window:close'),
    focusWindow: () => invoke('window:focus'),
    isMaximized: () => invoke('window:isMaximized'),
    zoom: (delta: number | null) => invoke('window:zoom', delta),
    setBackgroundMaterial: (enabled: boolean) => invoke('window:setBackgroundMaterial', enabled),
    backgroundMaterialSupported: () => invoke('window:backgroundMaterialSupported'),
    getGlassState: () => invoke('window:glassState'),
    onMaximizeChange: (callback: (isMaximized: boolean) => void) =>
      subscribe('window:maximize-changed', (isMaximized) => callback(Boolean(isMaximized))),

    auth: {
      status: () => invoke('auth:status'),
      setup: (params: { name: string; email: string; password: string; rememberMe: boolean }) =>
        invoke('auth:setup', params),
      login: (params: { email: string; password: string; rememberMe: boolean }) => invoke('auth:login', params),
      logout: () => invoke('auth:logout'),
      changePassword: (params: { currentPassword: string; newPassword: string }) =>
        invoke('auth:changePassword', params),
      setAvatar: (avatar: string) => invoke('auth:setAvatar', avatar),
      changeName: (name: string) => invoke('auth:changeName', { name }),
    },

    file: {
      open: (projectRoot?: string) => invoke('file:open', projectRoot),
      read: (filePath: string, projectRoot?: string) => invoke('file:read', filePath, projectRoot),
      estimateTokens: (files: string[], projectRoot?: string) => invoke('file:estimateTokens', files, projectRoot),
      readPreview: (filePath: string, projectRoot?: string) => invoke('file:readPreview', filePath, projectRoot),
      write: (filePath: string, content: string) => invoke('file:write', filePath, content),
      search: (keyword: string, projectRoot: string) => invoke('file:search', keyword, projectRoot),
      delete: (filePath: string, projectRoot?: string) => invoke('file:delete', filePath, projectRoot),
      rename: (oldPath: string, newPath: string, projectRoot?: string) =>
        invoke('file:rename', oldPath, newPath, projectRoot),
      createFolder: (dirPath: string, projectRoot?: string) => invoke('file:createFolder', dirPath, projectRoot),
      createFile: (filePath: string, projectRoot?: string) => invoke('file:createFile', filePath, projectRoot),
    },

    project: {
      getTree: (projectRoot: string) => invoke('project:getTree', projectRoot),
      applyCode: (payload: ApplyCodePayload) => invoke('project:applyCode', payload),
      previewCode: (payload: ApplyCodePayload) => invoke('project:previewCode', payload),
      selectDirectory: () => invoke('project:selectDirectory'),
      loadGlobalState: () => invoke('project:loadGlobalState'),
      saveGlobalState: (state: unknown) => invoke('project:saveGlobalState', state),
    },
  };
}
