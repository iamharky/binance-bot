// Command line helpers (run while the server is stopped, or alongside it: SQLite allows both).
//   npm run cli -- set-password          set or change the login password (logs every session out)
//   npm run cli -- kill [reason]         turn the global kill switch on (no new entries anywhere)
//   npm run cli -- unkill                turn it off
//   npm run cli -- bots                  list bots and their state
import { createInterface } from "node:readline";
import { RiskGuard } from "./bot/risk.js";
import { loadDotEnv, readConfig } from "./config.js";
import { openDb } from "./db.js";
import { Auth } from "./server/auth.js";

loadDotEnv();
const config = readConfig();
const store = openDb(config.dataDir);
const [cmd, ...rest] = process.argv.slice(2);

function ask(question, hidden = false) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => rl.output.write(s.includes(question) ? s : "");
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), process.stdout.write(hidden ? "\n" : ""), resolve(a))));
}

if (cmd === "set-password") {
  const p1 = await ask("New password: ", true);
  const p2 = await ask("Repeat it: ", true);
  if (p1 !== p2) {
    console.error("The passwords differ.");
    process.exit(1);
  }
  try {
    new Auth(store).setPassword(p1);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  console.log("Password set. Existing sessions were logged out.");
} else if (cmd === "kill") {
  new RiskGuard(store).setKillSwitch(true, rest.join(" ") || "from the command line");
  console.log("Kill switch ON: no bot opens a position until you turn it off (npm run cli -- unkill).");
} else if (cmd === "unkill") {
  new RiskGuard(store).setKillSwitch(false);
  console.log("Kill switch off.");
} else if (cmd === "bots") {
  for (const b of store.listBots()) {
    const t = store.openTrade(b.id);
    console.log(`#${b.id} ${b.name}: ${b.status}${b.halted_reason ? ` (${b.halted_reason})` : ""}, ${b.account} ${b.market} ${b.symbol} ${b.timeframe} ${b.strategy.kind}${t ? `, holds ${t.side} ${t.qty} @ ${t.entry_price}` : ", flat"}`);
  }
} else {
  console.log("Commands: set-password | kill [reason] | unkill | bots");
  process.exit(cmd ? 1 : 0);
}
store.close();
