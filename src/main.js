// Starts the bot server: resumes active bots, serves the UI and API, and shuts down cleanly on SIGINT / SIGTERM
// (open positions keep their exchange-side stops and targets while the process is down).
import { createApp } from "./app.js";
import { loadDotEnv, readConfig } from "./config.js";
import { ENGINE_INFO } from "./engine.js";

loadDotEnv();
const config = readConfig();
const app = createApp(config);

if (!app.auth.passwordSet) {
  console.log("No login password yet. Set one with: npm run cli -- set-password");
}
app.events.info("startup", `Engine from bist-charts ${ENGINE_INFO.commit.slice(0, 7)}${ENGINE_INFO.worktree ? " (working tree)" : ""}; live trading ${config.liveTradingEnabled ? "ENABLED" : "off"}`);

app.server.listen(config.port, config.host, () => {
  app.events.info("http", `Listening on http://${config.host}:${config.port}`);
});

await app.manager.init();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  app.events.info("shutdown", `Stopping (${signal}); bots resume on the next start`);
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (e) => app.events.error("unhandled", String(e?.stack ?? e)));
