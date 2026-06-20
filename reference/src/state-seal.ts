// Agent-owned state integrity — spec §9.3.
//
// `state` round-trips through the Hub and is UNTRUSTED until the agent verifies
// integrity IT applied. This module AEAD-seals (AES-256-GCM = encrypt-then-MAC)
// with a key the Hub never sees. The key MUST be agent-runtime-provisioned and
// MUST NOT live inside `state` (the embedded-key anti-pattern) — see openState's
// guard and spec §9.3 / KTD14.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { JsonObject } from "./types.js";

const MAGIC = "AHCPSEALv1"; // version tag; AES-256-GCM implied

function requireKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error("state-seal key must be 32 bytes (agent-owned, Hub-invisible — spec §9.3)");
  }
}

/** Encrypt-then-MAC a state object. Returns a compact `AHCPSEALv1.<iv>.<ct>.<tag>` token. */
export function sealState(state: JsonObject, key: Buffer): string {
  requireKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const pt = Buffer.from(JSON.stringify(state), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [MAGIC, iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

/** Verify + decrypt. Throws on tamper, wrong key, or malformed token. */
export function openState(sealed: string, key: Buffer): JsonObject {
  requireKey(key);
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== MAGIC) {
    throw new Error("unrecognized sealed-state token");
  }
  const iv = Buffer.from(parts[1]!, "base64url");
  const ct = Buffer.from(parts[2]!, "base64url");
  const tag = Buffer.from(parts[3]!, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let pt: Buffer;
  try {
    pt = Buffer.concat([decipher.update(ct), decipher.final()]); // GCM tag check throws on tamper
  } catch {
    throw new Error("state integrity verification failed (tampered or wrong key) — spec §9.3");
  }
  return JSON.parse(pt.toString("utf8")) as JsonObject;
}
