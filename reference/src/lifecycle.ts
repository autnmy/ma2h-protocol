// Atomic lifecycle — spec §7.
//
// A single-threaded Hub applies transitions sequentially, which models the
// normative atomic compare-and-set: the FIRST transition to a terminal status
// wins and is immutable; later attempts are no-ops returning the existing
// Response. `applyResolution` enforces that guard.

import type { A2hMessage, A2hResponse, Actor, JsonObject, Resolution, Status } from "./types.js";

export interface MessageRecord {
  id: string;
  message: A2hMessage;
  status: Status;
  createdAtMs: number;
  expiresAtMs: number | null;
  resolution_id: string | null;
  response: A2hResponse | null;
}

export type TransitionResult =
  | { applied: true; record: MessageRecord }
  | { applied: false; record: MessageRecord; reason: string };

export interface ResolveInput {
  resolution: Resolution;
  actor: Actor;
  resolved_at: string;
  resolution_id: string;
  value?: string | JsonObject;
  comment?: string;
  defaulted?: boolean;
  state?: JsonObject;
}

/** Apply a terminal transition. First-terminal-wins: a no-op if already terminal. */
export function applyResolution(record: MessageRecord, input: ResolveInput): TransitionResult {
  if (record.status !== "open") {
    return { applied: false, record, reason: `already terminal: ${record.status}` };
  }
  const response: A2hResponse = {
    ahcp_version: record.message.ahcp_version,
    in_reply_to: record.id,
    resolution_id: input.resolution_id,
    agent: { id: record.message.agent.id, run_id: record.message.agent.run_id },
    resolution: input.resolution,
    ...(input.defaulted !== undefined ? { defaulted: input.defaulted } : {}),
    response: {
      ...(input.value !== undefined ? { value: input.value } : {}),
      actor: input.actor,
      resolved_at: input.resolved_at,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
    },
    ...(input.state !== undefined ? { state: input.state } : {}),
  };
  record.status = input.resolution;
  record.resolution_id = input.resolution_id;
  record.response = response;
  return { applied: true, record };
}
