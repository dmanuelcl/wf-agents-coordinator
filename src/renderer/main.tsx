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

async function start(): Promise<void> {
  // Electron provides the bridge from preload. A normal browser gets the
  // identical API only after the user supplies the runner's bearer token.
  if (!window.agentCoordinator) await installBrowserRemoteApi(root);
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
