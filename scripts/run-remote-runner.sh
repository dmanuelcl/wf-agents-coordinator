#!/usr/bin/env bash
# Launches the remote runner under the Node version pinned in .nvmrc.
#
# The service must run the *same* Node that compiled the native addons: since
# Node 24.19.0 (nodejs/node#63642) `node::ObjectWrap`'s destructor calls
# RemoveEnvironmentCleanupHook(), which aborts the process from a garbage
# collection ("Assertion failed: (env) != nullptr").  Resolving the version here
# keeps .nvmrc the single source of truth, so the systemd/launchd unit never has
# to name a version and cannot drift from the one used to build.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(tr -d '[:space:]' <"${repo_root}/.nvmrc" | sed 's/^v//')"
node_bin="${AGENT_COORDINATOR_RUNNER_NODE:-${NVM_DIR:-${HOME}/.nvm}/versions/node/v${version}/bin/node}"

if [[ ! -x "${node_bin}" ]]; then
  echo "The remote runner is pinned to Node ${version} (.nvmrc), but ${node_bin} is not executable." >&2
  echo "Install it with:  nvm install ${version}" >&2
  echo "Or point AGENT_COORDINATOR_RUNNER_NODE at that Node binary." >&2
  exit 1
fi

actual="$("${node_bin}" -p 'process.versions.node')"
if [[ "${actual}" != "${version}" ]]; then
  echo "${node_bin} is Node ${actual}, but .nvmrc pins the runner to ${version}." >&2
  echo "Rebuild with 'pnpm remote:build' and use the matching binary." >&2
  exit 1
fi

# exec so the runner is the service's main process and receives SIGTERM directly.
exec "${node_bin}" "${repo_root}/out/main/remote-runner.js"
