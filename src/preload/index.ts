import { clipboard, contextBridge, ipcRenderer, shell, webUtils } from "electron";
import type { IpcRendererEvent } from "electron";
import { createAgentCoordinatorApi, type CoordinatorClientTransport } from "./agent-coordinator-api";
import { createRemoteIpcClient } from "./remote-ipc-client";

function cliValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function remoteConfig(): { url: string; token: string } | null {
  const url = cliValue("agent-coordinator-remote-url") ?? process.env["AGENT_COORDINATOR_REMOTE_URL"]?.trim();
  const token = cliValue("agent-coordinator-remote-token") ?? process.env["AGENT_COORDINATOR_REMOTE_TOKEN"]?.trim();
  if (!url && !token) return null;
  if (!url || !token) throw new Error("Remote Coordinator needs both AGENT_COORDINATOR_REMOTE_URL and AGENT_COORDINATOR_REMOTE_TOKEN.");
  return { url, token };
}

const remote = remoteConfig();
const localTransport: CoordinatorClientTransport = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  emit: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, callback) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

const remoteClient = remote ? createRemoteIpcClient(remote) : null;
const api = createAgentCoordinatorApi(remoteClient ?? localTransport, {
  mode: remote ? "remote" : "local",
  endpoint: remote?.url,
  connect: remoteClient?.connect,
  getPathForFile: remote
    ? () => {
        throw new Error("Dragging a local file is not available in remote mode yet. Put the file on the runner first.");
      }
    : (file) => webUtils.getPathForFile(file),
  clientSystem: remote
    ? {
        openExternal: async (url) => {
          if (/^https?:\/\//.test(url)) await shell.openExternal(url);
        },
        copyText: async (text) => clipboard.writeText(text),
      }
    : undefined,
});

contextBridge.exposeInMainWorld("agentCoordinator", api);
