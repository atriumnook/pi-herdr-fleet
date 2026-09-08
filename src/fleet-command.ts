export type FleetCommand = { action: "status" } | { action: "close-done" };

/**
 * `/fleet` with no args lists the fleet.
 * `/fleet close` and `/fleet close done` close non-interactive `done` panes.
 */
export function parseFleetCommand(args: string): FleetCommand {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens[0] === "close-done") return { action: "close-done" };
  if (
    tokens[0] === "close" &&
    (tokens[1] === undefined || tokens[1] === "done")
  ) {
    return { action: "close-done" };
  }
  return { action: "status" };
}
