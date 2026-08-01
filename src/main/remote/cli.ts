import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRemoteRunner } from "./runner";

function portFrom(value: string | undefined): number {
  if (!value) return 4765;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("AGENT_COORDINATOR_REMOTE_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

const token = process.env["AGENT_COORDINATOR_REMOTE_TOKEN"]?.trim();
if (!token) {
  throw new Error("Set AGENT_COORDINATOR_REMOTE_TOKEN before starting the remote runner.");
}

const runner = await startRemoteRunner({
  token,
  port: portFrom(process.env["AGENT_COORDINATOR_REMOTE_PORT"]),
  host: process.env["AGENT_COORDINATOR_REMOTE_HOST"]?.trim() || "127.0.0.1",
  stateDir: process.env["AGENT_COORDINATOR_STATE_DIR"]?.trim() || join(homedir(), ".agent-coordinator"),
  dataKey: process.env["AGENT_COORDINATOR_DATA_KEY"]?.trim(),
  staticDir: process.env["AGENT_COORDINATOR_WEB_DIR"]?.trim() || join(dirname(fileURLToPath(import.meta.url)), "../renderer"),
});

console.log(`Agent Coordinator runner listening on ${runner.port()}.`);

let closing = false;
async function close(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`Stopping Agent Coordinator runner (${signal})…`);
  await runner.close();
  process.exit(0);
}

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));
