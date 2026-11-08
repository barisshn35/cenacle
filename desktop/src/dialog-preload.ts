// SPDX-License-Identifier: AGPL-3.0-only
// The bridge of the app's dialog page: what to say, and which button was pressed.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cenacleDialog', {
  get: () => ipcRenderer.invoke('dialog:get'),
  ready: (height: number) => ipcRenderer.invoke('dialog:ready', height),
  answer: (response: number) => ipcRenderer.invoke('dialog:answer', response),
});
