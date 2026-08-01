import { isAbsolute, resolve } from "node:path";
import { createIpcHandlerRegistry } from "../ipc/ipc-transport";
import { createHeadlessSystemIntegration } from "../platform/system-integration";
import { createCoordinatorRuntime } from "../runtime/coordinator-runtime";
import { createNodeSecretCipher } from "../vcs/node-secret-cipher";
import { createRemoteRunnerServer, type RemoteRunnerServer } from "./runner-server";

export interface RemoteRunner {
  port(): number;
  close(): Promise<void>;
}

export interface StartRemoteRunnerOptions {
  stateDir: string;
  token: string;
  host?: string;
  port?: number;
  dataKey?: string;
  staticDir?: string;
}

export async function startRemoteRunner(options: StartRemoteRunnerOptions): Promise<RemoteRunner> {
  if (!isAbsolute(options.stateDir)) throw new Error("AGENT_COORDINATOR_STATE_DIR must be an absolute path.");
  const transport = createIpcHandlerRegistry();
  let server: RemoteRunnerServer | null = null;
  const runtime = await createCoordinatorRuntime({
    stateDir: resolve(options.stateDir),
    transport,
    systemIntegration: createHeadlessSystemIntegration(),
    vcsSecretCipher: createNodeSecretCipher(options.dataKey),
    broadcast(channel, payload) {
      server?.broadcast(channel, payload);
    },
  });
  try {
    server = await createRemoteRunnerServer({
      transport,
      token: options.token,
      host: options.host,
      port: options.port,
      staticDir: options.staticDir,
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  return {
    port: () => server!.port(),
    async close() {
      await server?.close();
      await runtime.close();
    },
  };
}
