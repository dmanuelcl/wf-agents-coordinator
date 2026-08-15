/**
 * Whether a repo workspace's active tab actually points at something.
 *
 * The workspace has no Log tab and no workflow roles, so it cannot fall back to
 * one the way a session does — when nothing is open it shows an empty state
 * instead. That makes this an exhaustive list of the tab kinds it does have, and
 * a missing entry does not hide a pane: it renders the empty state *next to* the
 * live one.
 */
export function repoTabIsOpen(params: {
  activeTab: string;
  diffOpen: boolean;
  shellTabIds: string[];
  agentTabKeys: string[];
  fileTabIds: string[];
}): boolean {
  const { activeTab, diffOpen, shellTabIds, agentTabKeys, fileTabIds } = params;
  if (activeTab === "diff") return diffOpen;
  return (
    shellTabIds.includes(activeTab) ||
    agentTabKeys.includes(activeTab) ||
    fileTabIds.includes(activeTab)
  );
}
