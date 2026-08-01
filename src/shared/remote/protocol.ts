/**
 * Versioned frames for the private Coordinator runner connection.  This is
 * intentionally small: it mirrors the IPC contract rather than exposing a
 * second, HTTP-specific domain API.
 */
export const REMOTE_PROTOCOL_VERSION = 1;

export interface RemoteHelloFrame {
  type: "hello";
  protocol: typeof REMOTE_PROTOCOL_VERSION;
  token: string;
}

export interface RemoteHelloOkFrame {
  type: "hello:ok";
  protocol: typeof REMOTE_PROTOCOL_VERSION;
}

export interface RemoteInvokeFrame {
  type: "invoke";
  id: string;
  channel: string;
  args: unknown[];
}

export interface RemoteEmitFrame {
  type: "emit";
  channel: string;
  args: unknown[];
}

export interface RemoteResponseFrame {
  type: "response";
  id: string;
  result?: unknown;
  error?: { message: string };
}

export interface RemoteEventFrame {
  type: "event";
  channel: string;
  payload: unknown;
}

export interface RemoteProtocolErrorFrame {
  type: "error";
  message: string;
}

export type RemoteClientFrame = RemoteHelloFrame | RemoteInvokeFrame | RemoteEmitFrame;
export type RemoteServerFrame =
  | RemoteHelloOkFrame
  | RemoteResponseFrame
  | RemoteEventFrame
  | RemoteProtocolErrorFrame;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse only recognised frames; malformed or future frames never reach handlers. */
export function parseRemoteClientFrame(value: unknown): RemoteClientFrame | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;

  if (
    value.type === "hello" &&
    value.protocol === REMOTE_PROTOCOL_VERSION &&
    typeof value.token === "string"
  ) {
    return { type: "hello", protocol: REMOTE_PROTOCOL_VERSION, token: value.token };
  }
  if (
    value.type === "invoke" &&
    typeof value.id === "string" &&
    typeof value.channel === "string" &&
    Array.isArray(value.args)
  ) {
    return { type: "invoke", id: value.id, channel: value.channel, args: value.args };
  }
  if (value.type === "emit" && typeof value.channel === "string" && Array.isArray(value.args)) {
    return { type: "emit", channel: value.channel, args: value.args };
  }
  return null;
}

export function parseRemoteFrameJson(raw: string): RemoteClientFrame | null {
  try {
    return parseRemoteClientFrame(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
