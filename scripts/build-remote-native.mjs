import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["node-pty", "better-sqlite3"];

/**
 * The runner pins its own Node version in `.nvmrc` instead of using whichever
 * Node happens to be default on the machine.  The addons must be *compiled* by
 * the same Node that later *runs* them, because `node::ObjectWrap` is a
 * header-only class that gets baked into each addon.
 *
 * Node 24.19.0 (nodejs/node#63642) made `~ObjectWrap()` call
 * `RemoveEnvironmentCleanupHook(v8::Isolate::GetCurrent(), ...)`.  better-sqlite3's
 * Statement/Database derive from `node::ObjectWrap`, so when V8 collects a dead
 * Statement during a GC driven by a platform task — no entered `v8::Context` —
 * `Environment::GetCurrent()` returns null and Node aborts with
 * "Assertion failed: (env) != nullptr" (src/api/hooks.cc:142), taking the whole
 * runner down.  Pinning to a Node whose headers predate that change avoids it.
 */
function pinnedNodeVersion() {
  return readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim().replace(/^v/, "");
}

/** Absolute path to the pinned Node, or null when it is not installed here. */
function pinnedNodePath(version) {
  const override = process.env["AGENT_COORDINATOR_RUNNER_NODE"]?.trim();
  if (override) return override;
  const fromNvm = join(homedir(), ".nvm/versions/node", `v${version}`, "bin/node");
  return existsSync(fromNvm) ? fromNvm : null;
}

/** Set on the re-executed child so a wrong-version Node fails instead of looping. */
const REEXEC_MARKER = "AGENT_COORDINATOR_RUNNER_NODE_REEXEC";

/**
 * Re-runs this script under the pinned Node when the current one differs, so
 * `pnpm remote:build` produces the same ABI regardless of the caller's shell.
 */
function reExecUnderPinnedNode(version) {
  if (process.env[REEXEC_MARKER]) {
    throw new Error(
      `AGENT_COORDINATOR_RUNNER_NODE points at Node ${process.versions.node}, ` +
        `but .nvmrc pins the runner to ${version}.`
    );
  }
  const nodePath = pinnedNodePath(version);
  if (!nodePath) {
    throw new Error(
      `The remote runner is pinned to Node ${version} (.nvmrc) but it is not installed.\n` +
        `Install it with:  nvm install ${version}\n` +
        `Or point AGENT_COORDINATOR_RUNNER_NODE at that Node binary.`
    );
  }
  console.log(`Re-running under ${nodePath} (pinned to Node ${version})...`);
  try {
    execFileSync(nodePath, [fileURLToPath(import.meta.url)], {
      stdio: "inherit",
      env: { ...process.env, [REEXEC_MARKER]: "1" }
    });
  } catch (error) {
    // The child already reported the failure on the inherited stderr; repeating
    // execFileSync's dump of it would only bury the actual message.
    process.exit(error.status ?? 1);
  }
}

/**
 * Fails the build when the headers node-gyp compiled against carry the
 * `node::ObjectWrap` cleanup hooks, rather than letting the runner ship an
 * addon that aborts the process from a garbage collection.
 */
function assertObjectWrapHasNoCleanupHooks(packageName, packageDir) {
  const configPath = join(packageDir, "build/config.gypi");
  const nodedir = /"nodedir":\s*"([^"]+)"/.exec(readFileSync(configPath, "utf8"))?.[1];
  if (!nodedir) throw new Error(`Could not read "nodedir" from ${configPath}.`);

  const headerPath = join(nodedir, "include/node/node_object_wrap.h");
  if (!existsSync(headerPath)) throw new Error(`Could not verify ${packageName}: ${headerPath} is missing.`);

  if (/RemoveCleanupHook\s*\(\s*\)/.test(readFileSync(headerPath, "utf8"))) {
    throw new Error(
      `${packageName} was compiled against ${nodedir}, whose node::ObjectWrap destructor calls\n` +
        `RemoveEnvironmentCleanupHook(). Addons built against those headers abort the runner from a\n` +
        `garbage collection ("Assertion failed: (env) != nullptr"). Build with the Node pinned in .nvmrc.`
    );
  }
}

const version = pinnedNodeVersion();
if (process.versions.node !== version) {
  reExecUnderPinnedNode(version);
} else {
  for (const packageName of PACKAGES) {
    const requireFromRoot = createRequire(import.meta.url);
    const packageJson = requireFromRoot.resolve(`${packageName}/package.json`);
    const requireFromPackage = createRequire(packageJson);
    const nodeGyp = requireFromPackage.resolve("node-gyp/bin/node-gyp.js");
    const packageDir = dirname(packageJson);

    console.log(`Building ${packageName} for Node ${process.version}...`);
    execFileSync(process.execPath, [nodeGyp, "rebuild", "--release"], {
      cwd: packageDir,
      env: { ...process.env, npm_config_build_from_source: "true" },
      stdio: "inherit"
    });

    assertObjectWrapHasNoCleanupHooks(packageName, packageDir);
  }
}
