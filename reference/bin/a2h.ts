#!/usr/bin/env -S node --import tsx
// A2H reference CLI — validate / sign / verify / run-vectors.
// Run: npm run a2h -- <cmd> ...   or   node --import tsx bin/a2h.ts <cmd> ...

import { readFileSync } from "node:fs";
import {
  validateCapability,
  validateMessage,
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

function inferKind(doc: unknown): "message" | "response" | "capability" {
  if (doc && typeof doc === "object") {
    const o = doc as Record<string, unknown>;
    if (typeof o["type"] === "string" && ["notify", "ask", "task"].includes(o["type"])) return "message";
    if ("in_reply_to" in o && "resolution" in o) return "response";
    if ("callback_auth_schemes" in o || "max_body_bytes" in o || "auth_schemes" in o) return "capability";
  }
  return "message";
}

function cmdValidate(positionals: string[], flags: Map<string, string>): void {
  const file = positionals[0];
  if (!file) die("usage: a2h validate <file> [--as message|response|capability]");
  const doc = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const kind = (flags.get("as") ?? inferKind(doc)) as "message" | "response" | "capability";
  const res: ValidationResult =
    kind === "response"
      ? validateResponse(doc)
      : kind === "capability"
        ? validateCapability(doc)
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
  if (!file || !key) die("usage: a2h sign <signed_context.json> --key <key>");
  const sc = JSON.parse(readFileSync(file, "utf8")) as SignedContext;
  console.log(signResponse(buildSignedContext(sc), { key }).header);
}

function cmdVerify(positionals: string[], flags: Map<string, string>): void {
  const file = positionals[0];
  const key = flags.get("key");
  const v1 = flags.get("v1");
  if (!file || !key || !v1) die("usage: a2h verify <signed_context.json> --v1 <sig> --key <key>");
  const sc = JSON.parse(readFileSync(file, "utf8")) as SignedContext;
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
      "A2H — Agent-to-Human Protocol",
      "",
      "A vendor-neutral protocol for an agent to reach a human and get a decision",
      "back. The agent-to-human complement to A2A and MCP.",
      "",
      "  MCP  →  agent ↔ tools",
      "  A2A  →  agent ↔ agent",
      "  A2H  →  agent ↔ human     ← this standard",
      "",
      "verbs: notify · ask · task        https://a2hprotocol.org",
    ].join("\n"),
  );
}

function cmdVerbs(): void {
  console.log(
    [
      "notify   FYI / summary / status. No response.            — a daily digest",
      "ask      A decision the human makes; answer routes back.  — ship / hold",
      "task     A manual action a human performs out-of-band.    — rotate a key",
    ].join("\n"),
  );
}

function cmdDocs(): void {
  console.log(
    [
      "spec         https://a2hprotocol.org/spec/v0.2.md",
      "skill        https://github.com/autnmy/a2h-protocol/blob/main/skill/SKILL.md",
      "reference    https://github.com/autnmy/a2h-protocol/tree/main/reference",
      "schemas      https://a2hprotocol.org/schema/v0.2/message.schema.json",
      "conformance  https://github.com/autnmy/a2h-protocol/tree/main/conformance",
      "repo         https://github.com/autnmy/a2h-protocol",
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
        "a2h — A2H reference CLI",
        "",
        "  a2h about                 what A2H is, in one screen",
        "  a2h verbs                 the three message verbs",
        "  a2h docs                  links to the spec, skill, schemas, repo",
        "  a2h rules                 the trust rules that matter",
        "  a2h validate <file> [--as message|response|capability]",
        "  a2h sign <signed_context.json> --key <key>",
        "  a2h verify <signed_context.json> --v1 <sig> --key <key>",
        "  a2h run-vectors",
      ].join("\n"),
    );
    process.exit(cmd === undefined ? 0 : 1);
}
