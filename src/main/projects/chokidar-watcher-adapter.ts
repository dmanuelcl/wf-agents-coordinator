import chokidar from "chokidar";
import type { CreateWatcher, WatcherHandle } from "./checkpoint-watcher";

export const createChokidarWatcher: CreateWatcher = (paths) => {
  // `depth: 0`: every caller watches a directory for files directly inside it.
  // chokidar opens one descriptor per directory it walks, so descending into
  // whatever an agent leaves there (a project copy with node_modules under
  // `.wf/`) exhausts the process's descriptors and every later `open` fails.
  const watcher = chokidar.watch(paths, { ignoreInitial: true, depth: 0 });

  // Without a listener the EventEmitter rethrows and takes the main process
  // down. A watch that fails only leaves its gate waiting.
  watcher.on("error", (error) => {
    console.error(`File watcher failed for ${paths.join(", ")}:`, error);
  });

  const handle: WatcherHandle = {
    onAdd: (cb) => {
      watcher.on("add", cb);
    },
    onChange: (cb) => {
      watcher.on("change", cb);
    },
    onUnlink: (cb) => {
      watcher.on("unlink", cb);
    },
    close: () => watcher.close(),
  };

  return handle;
};
