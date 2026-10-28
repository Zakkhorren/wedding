// Run manually only when intentionally switching the selected bot to a prepared Worker.
const { BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL, DRY_RUN } = process.env;
if (!BOT_TOKEN || !WEBHOOK_SECRET || !WORKER_URL)
  throw new Error(
    "Set BOT_TOKEN, WEBHOOK_SECRET and WORKER_URL in local environment",
  );
const base = new URL(WORKER_URL);
if (
  base.protocol !== "https:" ||
  base.username ||
  base.password ||
  base.search ||
  base.hash
)
  throw new Error("Invalid Worker URL");
const payload = {
  url: base.origin + "/telegram",
  secret_token: WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"],
};
if (DRY_RUN === "1") {
  console.log(
    "Dry run: webhook would point to " +
      payload.url +
      "; message and callback_query enabled. No request sent.",
  );
} else {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      },
    );
    const result = await response.json();
    if (!response.ok || !result.ok) throw Error();
    console.log("Webhook configured.");
  } catch {
    console.error("Webhook setup failed. Secret values were not printed.");
    process.exitCode = 1;
  }
}
