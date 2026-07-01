#!/usr/bin/env -S node --import tsx
// MA2H reference CLI — validate / sign / verify / run-vectors.
// Run: npm run ma2h -- <cmd> ...   or   node --import tsx bin/ma2h.ts <cmd> ...

import { readFileSync } from "node:fs";
import {
  validateAck,
  validateCapability,
  validateInboundMessage,
  validateMessage,
  validatePresence,
  validateResponse,
  type ValidationResult,
} from "../src/envelope.js";
import { buildSignedContext, signResponse, verifyResponse } from "../src/signing.js";
import { runVectors } from "../src/conformance.js";
import type { SignedContext } from "../src/types.js";

function parseArgs(argv: string[]): { positionals: string[]; flags: Map<string, string> } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      flags.set(a.slice(2), argv[i + 1] ?? "");
      i++;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

type ValidateKind = "message" | "response" | "capability" | "directive" | "ack" | "presence";

function inferKind(doc: unknown): ValidateKind {
  if (doc && typeof doc === "object") {
    const o = doc as Record<string, unknown>;
    if (o["type"] === "directive") return "directive";
    if (o["type"] === "ack") return "ack";
    if ("state" in o && "agent_id" in o) return "presence";
    if (typeof o["type"] === "string" && ["notify", "ask", "task"].includes(o["type"])) return "message";
    if ("in_reply_to" in o && "resolution" in o) return "response";
    if ("callback_auth_schemes" in o || "max_body_bytes" in o || "auth_schemes" in o) return "capability";
  }
  return "message";
}

function cmdValidate(positionals: string[], flags: Map<string, string>): void {
  const file = positionals[0];
  if (!file) die("usage: ma2h validate <file> [--as message|response|capability|directive|ack|presence]");
  const doc = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const kind = (flags.get("as") ?? inferKind(doc)) as ValidateKind;
  const res: ValidationResult =
    kind === "response"
      ? validateResponse(doc)
      : kind === "capability"
        ? validateCapability(doc)
        : kind === "directive"
          ? validateInboundMessage(doc)
          : kind === "ack"
            ? validateAck(doc)
            : kind === "presence"
              ? validatePresence(doc)
              : validateMessage(doc);
  if (res.valid) {
    console.log(`✓ valid ${kind}: ${file}`);
    return;
  }
  console.error(`✗ invalid ${kind}: ${file}`);
  for (const e of res.errors) console.error(`  - ${e}`);
  process.exit(1);
}

function cmdSign(positionals: string[], flags: Map<string, string>): void {
  const file = positionals[0];
  const key = flags.get("key");
  if (!file || !key) die("usage: ma2h sign <signed_context.json> --key <key>");
  const sc = JSON.parse(readFileSync(file, "utf8")) as SignedContext;
  if (typeof sc.payload_sha256 !== "string") {
    die("signed_context missing payload_sha256 (required in v0.3; see spec §9.2)");
  }
  console.log(signResponse(buildSignedContext(sc), { key }).header);
}

function cmdVerify(positionals: string[], flags: Map<string, string>): void {
  const file = positionals[0];
  const key = flags.get("key");
  const v1 = flags.get("v1");
  if (!file || !key || !v1) die("usage: ma2h verify <signed_context.json> --v1 <sig> --key <key>");
  const sc = JSON.parse(readFileSync(file, "utf8")) as SignedContext;
  if (typeof sc.payload_sha256 !== "string") {
    die("signed_context missing payload_sha256 (required in v0.3; see spec §9.2)");
  }
  const r = verifyResponse(buildSignedContext(sc), v1, { key });
  if (r.ok) {
    console.log("✓ signature ok");
    return;
  }
  die(`✗ ${r.reason}`);
}

function cmdVectors(): void {
  const report = runVectors();
  for (const r of report.results) {
    const mark = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "○";
    console.log(`${mark} [${r.cls}] ${r.id}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${report.passed} passed · ${report.failed} failed · ${report.skipped} skipped`);
  if (report.failed > 0) process.exit(1);
}

function cmdAbout(): void {
  console.log(
    [
      "MA2H — Multi-agent to Human Protocol",
      "",
      "A vendor-neutral protocol for an agent to reach a human and get a decision",
      "back. The agent↔human complement to A2A and MCP.",
      "",
      "  MCP   →  agent ↔ tools",
      "  A2A   →  agent ↔ agent",
      "  MA2H  →  agent ↔ human     ← this standard",
      "",
      "verbs: notify · ask · task        https://ma2h.org",
    ].join("\n"),
  );
}

function cmdVerbs(): void {
  console.log(
    [
      "notify    FYI / summary / status. No response.            — a daily digest",
      "ask       A decision the human makes; answer routes back.  — ship / hold",
      "task      A manual action a human performs out-of-band.    — rotate a key",
      "",
      "directive (v0.4, inbound) A human → one agent; the agent  — freeze deploys",
      "          drains its mailbox and acts. No response leg.",
    ].join("\n"),
  );
}

function cmdDocs(): void {
  console.log(
    [
      "spec         https://ma2h.org/spec/v0.4.md",
      "plugin       https://github.com/autnmy/ma2h-protocol/tree/main/plugins/ma2h-skills",
      "reference    https://github.com/autnmy/ma2h-protocol/tree/main/reference",
      "schemas      https://ma2h.org/schema/v0.4/message.schema.json",
      "conformance  https://github.com/autnmy/ma2h-protocol/tree/main/conformance",
      "repo         https://github.com/autnmy/ma2h-protocol",
    ].join("\n"),
  );
}

function cmdRules(): void {
  console.log(
    [
      "- The Hub assigns the message id; idempotency_key is required on ask/task.",
      "- state is agent-owned and AEAD-sealed — the Hub never holds the key;",
      "  returned state is untrusted until verified.",
      "- Every pushed Response is signed (RFC 8785 JCS + detached signature);",
      "  agents verify, dedupe, and act at most once.",
      "- actor is Hub-attested; resolver authz is fail-closed; callbacks must",
      "  target an agent-owned, verified host.",
    ].join("\n"),
  );
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const { positionals, flags } = parseArgs(argv.slice(1));

switch (cmd) {
  case "validate":
    cmdValidate(positionals, flags);
    break;
  case "sign":
    cmdSign(positionals, flags);
    break;
  case "verify":
    cmdVerify(positionals, flags);
    break;
  case "run-vectors":
  case "vectors":
    cmdVectors();
    break;
  case "about":
    cmdAbout();
    break;
  case "verbs":
    cmdVerbs();
    break;
  case "docs":
    cmdDocs();
    break;
  case "rules":
    cmdRules();
    break;
  default:
    console.log(
      [
        "ma2h — MA2H reference CLI",
        "",
        "  ma2h about                 what MA2H is, in one screen",
        "  ma2h verbs                 the three message verbs",
        "  ma2h docs                  links to the spec, skill, schemas, repo",
        "  ma2h rules                 the trust rules that matter",
        "  ma2h validate <file> [--as message|response|capability|directive|ack|presence]",
        "  ma2h sign <signed_context.json> --key <key>",
        "  ma2h verify <signed_context.json> --v1 <sig> --key <key>",
        "  ma2h run-vectors",
      ].join("\n"),
    );
    process.exit(cmd === undefined ? 0 : 1);
}
