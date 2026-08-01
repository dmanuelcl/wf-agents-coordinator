import { createAgentCoordinatorApi } from "../preload/agent-coordinator-api";
import { createRemoteIpcClient } from "../preload/remote-ipc-client";

const ENDPOINT_KEY = "agent-coordinator.remote.endpoint";
const TOKEN_KEY = "agent-coordinator.remote.token";

function defaultEndpoint(): string {
  const endpoint = new URL("/rpc", window.location.href);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return endpoint.toString();
}

function promptForConnection(container: HTMLElement): Promise<{ endpoint: string; token: string }> {
  return new Promise((resolve) => {
    const form = document.createElement("form");
    form.className = "remote-connect";
    const title = document.createElement("h1");
    title.textContent = "Agent Coordinator";
    const detail = document.createElement("p");
    detail.textContent = "Connect to your private Coordinator runner.";
    const endpointLabel = document.createElement("label");
    endpointLabel.textContent = "Runner WebSocket URL";
    const endpoint = document.createElement("input");
    endpoint.type = "url";
    endpoint.required = true;
    endpoint.value = sessionStorage.getItem(ENDPOINT_KEY) ?? defaultEndpoint();
    const tokenLabel = document.createElement("label");
    tokenLabel.textContent = "Connection token";
    const token = document.createElement("input");
    token.type = "password";
    token.required = true;
    token.autocomplete = "current-password";
    token.value = sessionStorage.getItem(TOKEN_KEY) ?? "";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Connect";
    form.append(title, detail, endpointLabel, endpoint, tokenLabel, token, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = { endpoint: endpoint.value.trim(), token: token.value.trim() };
      sessionStorage.setItem(ENDPOINT_KEY, values.endpoint);
      sessionStorage.setItem(TOKEN_KEY, values.token);
      resolve(values);
    });
    container.replaceChildren(form);
    token.focus();
  });
}

/** Install the same Coordinator bridge in a normal browser before React mounts. */
export async function installBrowserRemoteApi(container: HTMLElement): Promise<void> {
  const storedEndpoint = sessionStorage.getItem(ENDPOINT_KEY);
  const storedToken = sessionStorage.getItem(TOKEN_KEY);
  const connection =
    storedEndpoint && storedToken
      ? { endpoint: storedEndpoint, token: storedToken }
      : await promptForConnection(container);
  window.agentCoordinator = createAgentCoordinatorApi(createRemoteIpcClient({ url: connection.endpoint, token: connection.token }), {
    mode: "remote",
    endpoint: connection.endpoint,
    getPathForFile: () => {
      throw new Error("Dragging a local file is not available in the web client yet. Put it on the runner first.");
    },
    clientSystem: {
      openExternal: async (url) => {
        if (/^https?:\/\//.test(url)) window.open(url, "_blank", "noopener,noreferrer");
      },
      copyText: async (text) => navigator.clipboard.writeText(text),
    },
  });
}
