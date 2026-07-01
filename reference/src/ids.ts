// Opaque, random identifiers. `resolution_id` MUST be unguessable (spec §6, KTD1b);
// randomUUID provides 122 bits of entropy.

import { randomUUID } from "node:crypto";

export const newMessageId = (): string => `msg_${randomUUID()}`;
export const newResolutionId = (): string => `res_${randomUUID()}`;
export const newJti = (): string => `jti_${randomUUID()}`;
/** Inbound directive id (spec §13.1) — the agent's at-most-once dedup key. */
export const newDirectiveId = (): string => `dir_${randomUUID()}`;
