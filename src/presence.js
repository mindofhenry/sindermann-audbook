// Nobody listening means nobody can keep their place, so an empty voice
// channel pauses the book. If it stays empty, the bot leaves.

export function createPresenceWatcher({ sessions, leaveAfterMs }) {
  const autoPaused = new Set(); // guilds this watcher paused (not the user)
  const leaveTimers = new Map();

  const cancelLeave = (guildId) => {
    clearTimeout(leaveTimers.get(guildId));
    leaveTimers.delete(guildId);
  };

  return {
    /** Call whenever the number of human listeners in the bot's channel changes. */
    update(guildId, listenerCount) {
      const session = sessions.get(guildId);
      if (!session) return;

      if (listenerCount > 0) {
        cancelLeave(guildId);
        if (autoPaused.delete(guildId)) session.resume();
        return;
      }

      if (session.pause()) autoPaused.add(guildId);
      if (leaveTimers.has(guildId)) return; // grace period already running
      leaveTimers.set(guildId, setTimeout(() => {
        leaveTimers.delete(guildId);
        autoPaused.delete(guildId);
        sessions.leave(guildId);
      }, leaveAfterMs));
    },

    /** Forget a guild, e.g. after the bot left for another reason. */
    forget(guildId) {
      cancelLeave(guildId);
      autoPaused.delete(guildId);
    },
  };
}
