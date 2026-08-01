import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installBrowserRemoteApi } from "./remote-browser";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element not found");
}
const root = container;

function showConnectionError(error: unknown): void {
  const panel = document.createElement("div");
  panel.className = "remote-connect";
  const title = document.createElement("h1");
  title.textContent = "Could not connect";
  const detail = document.createElement("p");
  detail.className = "remote-connect-error";
  detail.textContent = error instanceof Error ? error.message : String(error);
  const hint = document.createElement("p");
  hint.textContent = "Check the remote URL and token, then relaunch Agent Coordinator.";
  panel.append(title, detail, hint);
  root.replaceChildren(panel);
}

async function start(): Promise<void> {
  // Electron provides the bridge from preload. A normal browser gets the
  // identical API only after the user supplies the runner's bearer token.
  try {
    if (!window.agentCoordinator) await installBrowserRemoteApi(root);
    await window.agentCoordinator.connection.connect();
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  } catch (error) {
    showConnectionError(error);
  }
}

void start();
