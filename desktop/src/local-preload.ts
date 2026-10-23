// SPDX-License-Identifier: AGPL-3.0-only
// The bridge of the app's own pages (pairing, offline).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cenacleLocal', {
  texts: () => ipcRenderer.invoke('pair:texts'),
  recent: () => ipcRenderer.invoke('pair:recent'),
  forget: (origin: string) => ipcRenderer.invoke('pair:forget', origin),
  connect: (address: string) => ipcRenderer.invoke('pair:connect', address),
  retry: () => ipcRenderer.invoke('offline:retry'),
  changeServer: () => ipcRenderer.invoke('desktop:change-server'),
});
