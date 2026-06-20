// AHCP playground — YOU are the human in the loop.
//
//   npm run demo
//
// A deploy-bot posts a digest (notify) and a ship/hold decision (ask), seals its
// resume state, and "exits". You answer in the terminal. The Hub signs the answer
// and pushes it; a fresh agent verifies the signature, opens the sealed state, and
// acts on YOUR choice. Then it shows a replay being rejected.

import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { Hub, type DeliveredPush } from "../src/hub.js";
import { Agent } from "../src/agent.js";
import { sealState } from "../src/state-seal.js";
import type { A2hMessage, ResponseOption } from "../src/types.js";

const HUB_KEY = "demo-hub-hmac-secret-0123456789abcdef0123456789abcdef";
const RESUME_URL = "https://deploy-bot.example/ahcp/resume";
const OPTIONS: ResponseOption[] = [
  { value: "ship", label: "Ship to prod now" },
  { value: "hold", label: "Hold for review" },
];

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const sealKey = randomBytes(32); // the bot's own key — the Hub NEVER sees it
  const buildSha = "abc123def";
  const pushes: DeliveredPush[] = [];
  const hub = new Hub({ signingKey: HUB_KEY, onDeliver: (p) => { pushes.push(p); } });
  const agent = new Agent({ callbackUrl: RESUME_URL, callbackKey: HUB_KEY, sealKey });

  console.log("\n=== AHCP playground — you are the human in the loop ===\n");

  const notify: A2hMessage = {
    ahcp_version: "0.3",
    type: "notify",
    created_at: new Date().toISOString(),
    agent: { id: "deploy-bot/ci", run_id: "digest_1", runtime: "github-actions", project: "demo" },
    title: "Deploy digest — 5 deploys, 1 failure (last 24h)",
    idempotency_key: "demo-digest-1",
    body: "5 shipped, 1 rolled back. Candidate build abc123def is green.",
  };
  const nAck = hub.submit(notify);
  console.log(`📬  notify → "${notify.title}"  [durable · status=${nAck.status}]\n`);

  const ask: A2hMessage = {
    ahcp_version: "0.3",
    type: "ask",
    created_at: new Date().toISOString(),
    agent: { id: "deploy-bot/ci", run_id: "ship_1", runtime: "github-actions", project: "demo" },
    title: "Ship the candidate build to prod, or hold?",
    idempotency_key: "demo-ship-1",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    state: { sealed: sealState({ build_sha: buildSha, pr: 4201 }, sealKey) },
    body: "CI is green on abc123def. Ship to production now, or hold for review?",
    request: {
      mode: "select",
      options: OPTIONS,
      default_on_expire: "hold", // unanswered ⇒ fail-closed (no auto-ship)
      allowed_resolvers: ["human:you"],
      callback: { mode: "push", url: RESUME_URL, auth: { scheme: "hmac", secret_ref: "env:K" } },
    },
  };
  const ack = hub.submit(ask);
  console.log("📬  NEW DECISION in your inbox:");
  console.log(`      ${ask.title}`);
  for (const o of OPTIONS) console.log(`        • ${o.value} — ${o.label}`);
  console.log("      (the agent has now EXITED; its resume context is AEAD-sealed, opaque to the Hub)\n");

  let choice = "";
  while (choice !== "ship" && choice !== "hold") {
    choice = (await rl.question("👤  Your decision [ship/hold]: ")).trim().toLowerCase();
  }
  rl.close();

  hub.resolve(ack.id, { actor: "human:you", resolution: "answered", value: choice });
  const push = pushes[0];
  if (!push) {
    console.log("(no delivery — unexpected)");
    return;
  }
  console.log("\n🔏  Hub attested the actor, signed the Response, and pushed it to the agent:");
  console.log(`      ${push.signature.slice(0, 76)}…\n`);

  const r = agent.onResume(push.response, push.signature);
  if (r.acted) {
    console.log("🤖  Agent re-invoked (fresh process): signature verified ✓, sealed state opened ✓");
    console.log(`      reconstructed context: ${JSON.stringify(r.state)}`);
    const v = r.value;
    const action = v === "ship" ? `🚀 DEPLOYING ${buildSha}` : "✋ HOLDING — not deploying";
    console.log(`      you chose "${String(v)}" → ${action}\n`);
  } else {
    console.log(`🤖  Agent refused to act: ${r.reason}\n`);
  }

  const replay = agent.onResume(push.response, push.signature);
  const tail = replay.acted ? "" : ` (${replay.reason})`;
  console.log(`🛡️  Replaying the same signed Response → acted=${String(replay.acted)}${tail}\n`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
