import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";

/**
 * The remote runner is executed by the host's Node.js, not Electron.  Build
 * each native addon with that exact Node ABI, rather than relying on pnpm's
 * rebuild state (which can be skipped after an --ignore-scripts install).
 */
for (const packageName of ["node-pty", "better-sqlite3"]) {
  const requireFromRoot = createRequire(import.meta.url);
  const packageJson = requireFromRoot.resolve(`${packageName}/package.json`);
  const requireFromPackage = createRequire(packageJson);
  const nodeGyp = requireFromPackage.resolve("node-gyp/bin/node-gyp.js");

  console.log(`Building ${packageName} for Node ${process.version}...`);
  execFileSync(process.execPath, [nodeGyp, "rebuild", "--release"], {
    cwd: dirname(packageJson),
    env: { ...process.env, npm_config_build_from_source: "true" },
    stdio: "inherit"
  });
}
