/**
 * Ending a call, in one place so the ordering below can be tested without a
 * network, a werift peer connection or a running server.
 *
 * A call ends in one of two ways, and its outcome (duration, turns, transcript,
 * why it ended) has to be reported on BOTH:
 *
 *   - the session ends itself (silence, too long, too many turns, STT failure):
 *     it builds the summary and hands it to onEnd, which calls teardown WITH it.
 *   - something outside ends it (the student taps End -> /hangup, the ICE
 *     connection drops, the process shuts down): teardown is called WITHOUT a
 *     summary, so it asks the session to end and uses the summary that returns.
 *
 * The outside case used to report nothing. end() builds the summary and calls
 * onEnd, which re-enters teardown; that inner call returned at once because the
 * outer call had already removed the entry from `sessions`, and the outer call
 * had no summary of its own to report. So the duration, outcome and end time of
 * every call ended by /hangup or an ICE drop never reached call_events.
 */
export function createTeardown({ sessions, reportOutcome, log = console }) {
  return async function teardown(entry, reason, summary) {
    // Only the first caller for a call does anything. The session's own onEnd
    // re-enters here while that first call is still running, and /hangup can
    // race an ICE state change.
    if (!sessions.has(entry.callId)) return;
    sessions.delete(entry.callId);
    log.info(`[${entry.callId}] teardown: ${reason}`);

    // end() returns the summary the first time it runs and nothing afterwards,
    // so this is the summary of exactly the call being torn down. When the
    // session ended itself, end() has already run and `summary` was passed in.
    let finalSummary = summary;
    try { finalSummary = (await entry.session?.end(reason)) ?? summary; } catch {}
    try { await entry.pc.close(); } catch {}

    // Report the outcome so the platform can record duration, turns and
    // transcript. Best-effort: the call is already over.
    if (finalSummary) {
      await reportOutcome(finalSummary).catch((e) => log.error("[teardown] report:", e.message));
    }
  };
}
