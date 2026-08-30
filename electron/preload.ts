/** preload.ts — exposes the renderer-safe `electronAPI` surface. */
import { contextBridge } from 'electron';
import { createElectronAPI } from './preload-api';

export const electronAPI = createElectronAPI();

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
