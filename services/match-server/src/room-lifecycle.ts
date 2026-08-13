export interface HostedRoom {
  matchId: string;
  playerCount: number;
  finished: boolean;
}

export interface RoomRetirementOptions {
  mode: string;
  graceMs?: number;
  exitContainer?: () => void;
}

/** Remove abandoned matches immediately, while preserving the score-screen
 * grace period for matches that actually reached a result. Bots are simulation
 * players, not connected clients, so they never keep a room alive here. */
export function retireRoom<R extends HostedRoom>(
  rooms: Map<string, R>,
  room: R,
  options: RoomRetirementOptions
): void {
  const remove = (): void => {
    // A room with the same id may already have been recreated. A stale cleanup
    // timer must never delete that replacement.
    if (rooms.get(room.matchId) !== room) return;
    rooms.delete(room.matchId);
    if (options.mode === "container") options.exitContainer?.();
  };

  if (room.playerCount === 0) {
    remove();
    return;
  }

  setTimeout(() => {
    if (room.playerCount > 0 && !room.finished) return;
    remove();
  }, options.graceMs ?? 30_000);
}
