// Reference agent (client) — spec §2.1, §6, §9.2/§9.3.
//
// Models the ephemeral resume flow: the agent seals state before submitting, then
// a (possibly new) process calls `onResume` when a signed Response arrives by push
// or pull. onResume verifies the signature, deduplicates, and opens the sealed
// state — treating everything on the return leg as untrusted until verified.

import { buildSignedContext, computePayloadSha256, verifyResponse } from "./signing.js";
import { openState } from "./state-seal.js";
import type { A2hResponse, JsonObject, Resolution } from "./types.js";

export interface ParsedSignature {
  t: string;
  jti: string;
  v1: string;
}

/** Parse an `AHCP-Signature: t=..,jti=..,v1=..` header. */
export function parseSignatureHeader(header: string): ParsedSignature {
  const body = header.replace(/^AHCP-Signature:\s*/i, "");
  const parts = new Map<string, string>();
  for (const kv of body.split(",")) {
    const eq = kv.indexOf("=");
    if (eq > 0) parts.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
  }
  const t = parts.get("t");
  const jti = parts.get("jti");
  const v1 = parts.get("v1");
  if (t === undefined || jti === undefined || v1 === undefined) {
    throw new Error("malformed AHCP-Signature header");
  }
  return { t, jti, v1 };
}

export type ResumeResult =
  | { acted: true; resolution: Resolution; state: JsonObject | null; value?: string | JsonObject }
  | { acted: false; reason: string };

export interface AgentOptions {
  /** This agent's own callback URL (bound into the signature). */
  callbackUrl: string;
  /** Key used to verify the Hub's Response signature. */
  callbackKey: string;
  /** Agent-owned, Hub-invisible key for sealing/opening `state` (32 bytes). */
  sealKey: Buffer;
  windowSeconds?: number;
}

export class Agent {
  private readonly seen = new Set<string>();
  private readonly opts: AgentOptions;

  constructor(opts: AgentOptions) {
    this.opts = opts;
  }

  /** Handle a Response delivered by push (or fetched by pull). At-most-once. */
  onResume(response: A2hResponse, signatureHeader: string, nowMs?: number): ResumeResult {
    let sig: ParsedSignature;
    try {
      sig = parseSignatureHeader(signatureHeader);
    } catch (e) {
      return { acted: false, reason: (e as Error).message };
    }

    const sc = buildSignedContext({
      ahcp_version: response.ahcp_version,
      callback_url: this.opts.callbackUrl,
      id: response.in_reply_to,
      in_reply_to: response.in_reply_to,
      jti: sig.jti,
      // §9.2 (issue #7): RECOMPUTE the payload digest from the payload we actually received,
      // so a tampered value/comment/actor/state diverges the digest and fails verification.
      payload_sha256: computePayloadSha256(response.response, response.state),
      resolution: response.resolution,
      resolution_id: response.resolution_id,
      resolved_at: response.response?.resolved_at ?? "",
      t: sig.t,
    });
    const verified = verifyResponse(sc, sig.v1, {
      key: this.opts.callbackKey,
      now: nowMs ?? Date.now(),
      ...(this.opts.windowSeconds !== undefined ? { windowSeconds: this.opts.windowSeconds } : {}),
    });
    if (!verified.ok) return { acted: false, reason: `signature: ${verified.reason}` };

    const dedupKey = `${response.in_reply_to}::${response.resolution_id}`;
    if (this.seen.has(dedupKey)) return { acted: false, reason: "duplicate delivery (already acted)" };

    // Open sealed state ONLY after signature verification; reject tamper.
    let state: JsonObject | null = null;
    const sealed = response.state?.["sealed"];
    if (typeof sealed === "string") {
      try {
        state = openState(sealed, this.opts.sealKey);
      } catch (e) {
        return { acted: false, reason: (e as Error).message };
      }
    }

    this.seen.add(dedupKey); // commit only once we will actually act
    return {
      acted: true,
      resolution: response.resolution,
      state,
      ...(response.response?.value !== undefined ? { value: response.response.value } : {}),
    };
  }
}
