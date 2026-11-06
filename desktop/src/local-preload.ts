// SPDX-License-Identifier: AGPL-3.0-only
// The bridge of the app's own pages (pairing, offline).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cenacleLocal', {
  texts: () => ipcRenderer.invoke('pair:texts'),
  recent: () => ipcRenderer.invoke('pair:recent'),
  forget: (origin: string) => ipcRenderer.invoke('pair:forget', origin),
  connect: (address: string) => ipcRenderer.invoke('pair:connect', address),
  continue: () => ipcRenderer.invoke('pair:continue'),
  cancel: () => ipcRenderer.invoke('pair:back'),
  privacy: () => ipcRenderer.invoke('pair:privacy'),
  retry: () => ipcRenderer.invoke('offline:retry'),
  changeServer: () => ipcRenderer.invoke('desktop:change-server'),
  // The bar of windows for others' pages.
  frameTexts: () => ipcRenderer.invoke('frame:texts'),
  onFrame: (
    listener: (page: {
      host: string;
      secure: boolean;
      browse: boolean;
      canGoBack: boolean;
    }) => void,
  ) => {
    ipcRenderer.on('frame:page', (_e, page) => listener(page));
  },
  back: () => ipcRenderer.invoke('frame:back'),
  reload: () => ipcRenderer.invoke('frame:reload'),
});
