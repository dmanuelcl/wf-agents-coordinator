import chokidar from "chokidar";
import type { CreateWatcher, WatcherHandle } from "./checkpoint-watcher";

export const createChokidarWatcher: CreateWatcher = (paths) => {
  const watcher = chokidar.watch(paths, { ignoreInitial: true });

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
