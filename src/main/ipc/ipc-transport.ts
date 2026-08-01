/**
 * The small part of Electron's IPC surface used by Coordinator's domain
 * handlers. Keeping this boundary transport-neutral lets the same handlers run
 * behind Electron today and a persistent remote runner in a later phase.
 */
export interface IpcMessageSender {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export interface IpcRequestEvent {
  sender: IpcMessageSender;
}

export interface IpcTransport {
  handle(channel: string, listener: (event: IpcRequestEvent, ...args: any[]) => unknown): void;
  on(channel: string, listener: (event: IpcRequestEvent, ...args: any[]) => void): void;
}

/**
 * In-process handler table used by the remote runner. It deliberately mirrors
 * Electron's split between request/response (`handle`) and fire-and-forget
 * terminal input (`on`), so the domain handlers stay unchanged.
 */
export interface IpcHandlerRegistry extends IpcTransport {
  invoke(sender: IpcMessageSender, channel: string, args: readonly unknown[]): Promise<unknown>;
  emit(sender: IpcMessageSender, channel: string, args: readonly unknown[]): void;
  hasHandler(channel: string): boolean;
  hasListener(channel: string): boolean;
}

export function createIpcHandlerRegistry(): IpcHandlerRegistry {
  const handlers = new Map<string, (event: IpcRequestEvent, ...args: any[]) => unknown>();
  const listeners = new Map<string, (event: IpcRequestEvent, ...args: any[]) => void>();

  return {
    handle(channel, listener) {
      if (handlers.has(channel)) throw new Error(`IPC handler already registered for ${channel}`);
      handlers.set(channel, listener);
    },
    on(channel, listener) {
      if (listeners.has(channel)) throw new Error(`IPC listener already registered for ${channel}`);
      listeners.set(channel, listener);
    },
    async invoke(sender, channel, args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
      return handler({ sender }, ...args);
    },
    emit(sender, channel, args) {
      const listener = listeners.get(channel);
      if (!listener) throw new Error(`No IPC listener registered for ${channel}`);
      listener({ sender }, ...args);
    },
    hasHandler(channel) {
      return handlers.has(channel);
    },
    hasListener(channel) {
      return listeners.has(channel);
    },
  };
}
