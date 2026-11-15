/**
 * Team alerts via Slack incoming webhook.
 *
 * Free on Slack's free plan — no per-message cost, unlike WhatsApp templates.
 * Configure with the SLACK_WEBHOOK_URL env var (Vercel -> Settings ->
 * Environment Variables). Fail-open: if unset, alerts are silently skipped
 * so a missing webhook never breaks payments or cron jobs.
 */
export async function sendSlackAlert(text: string): Promise<boolean> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch (e) {
    console.error("[slack] alert failed:", (e as Error).message);
    return false;
  }
}
