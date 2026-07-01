// MA2H playground — YOU are the human in the loop.
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
const RESUME_URL = "https://deploy-bot.example/ma2h/resume";
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
  const agent = new Agent({ callbackUrl: RESUME_URL, callbackKey: HUB_KEY, sealKey, agentId: "agent:deploy-bot/ci" });

  console.log("\n=== MA2H playground — you are the human in the loop ===\n");

  const notify: A2hMessage = {
    ma2h_version: "0.4",
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
    ma2h_version: "0.4",
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

  // --- v0.4 inbound leg: now YOU send the agent a directive ---
  console.log("=== v0.4 inbound leg — you send the agent a directive ===\n");
  const { id: dirId } = hub.sendDirective({
    from: "human:you",
    to: "agent:deploy-bot/ci",
    title: "Freeze deploys until the incident clears",
    body: "Prod incident in progress — hold all deploys until I say otherwise.",
    priority: "urgent",
  });
  console.log(`✉️   you → agent:deploy-bot/ci  "Freeze deploys…"  [durable mailbox · id=${dirId.slice(0, 12)}…]`);

  const [delivery] = hub.drainInbox("deploy-bot/ci");
  if (!delivery) {
    console.log("(no directive drained — unexpected)");
    return;
  }
  const dr = agent.receiveDirective(delivery.directive, delivery.signature);
  if (dr.acted) {
    console.log(`🤖  Agent drained it, verified the §9.7 signature ✓ → "${dr.directive.title}"`);
    // ... the agent durably processes the directive here ...
    dr.commit(); // record the id for dedup ONLY after processing (verify -> act -> commit -> ack)
    hub.ackInbox("deploy-bot/ci", [dr.directive.id]);
    console.log("      acked (consumed) — the Hub will not redeliver it\n");
  } else {
    console.log(`🤖  Agent refused the directive: ${dr.reason}\n`);
  }

  const dup = agent.receiveDirective(delivery.directive, delivery.signature);
  const dupTail = dup.acted ? "" : ` (${dup.reason})`;
  console.log(`🛡️  Same directive re-presented → acted=${String(dup.acted)}${dupTail}\n`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
