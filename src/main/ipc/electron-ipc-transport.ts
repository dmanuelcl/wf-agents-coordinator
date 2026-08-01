import { ipcMain } from "electron";
import type { IpcTransport } from "./ipc-transport";

/** Registers a transport-neutral Coordinator handler on Electron's IPC bus. */
export function createElectronIpcTransport(): IpcTransport {
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...args) => listener({ sender: event.sender }, ...args));
    },
    on(channel, listener) {
      ipcMain.on(channel, (event, ...args) => listener({ sender: event.sender }, ...args));
    },
  };
}
