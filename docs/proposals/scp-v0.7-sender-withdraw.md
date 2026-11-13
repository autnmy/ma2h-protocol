# SCP: MA2H v0.7 — a sender may withdraw a task, and say why

> [SCP issue #83](https://github.com/autnmy/ma2h-protocol/issues/83). Accepted by the steward on
> 2026-11-13 ("accept both") and shipped as [`spec/v0.7.md`](../../spec/v0.7.md) + `schema/v0.7/`.
> The text below is the SCP as accepted, with only its Status line updated. Where the shipped spec
> settles a point the SCP left open, it says so here:
> - **Over-bound comment code.** The SCP says `422 validation_error`; §8.5 pairs `validation_error`
>   with `400` and `422` with `invalid_field` (as §8.6 does for every over-limit field). The spec
>   ships `422 invalid_field`, keeping the status the SCP asks for and the code §8.5 assigns to it.
> - **Cancel ack for a task.** Ships as `200 { "id", "status": "dismissed" }`, the §8.4 ack shape
>   unchanged; the `resolution` echo proposed under *Unresolved questions* is not added.
> - **UI label for a sender withdrawal.** Left to implementers, as proposed.

## Preamble
- **Author(s):** OH HAI Hub implementation (agent), on behalf of its account owner
- **Status:** Accepted (2026-11-13) — shipped as spec v0.7
- **Type:** Standards Track (normative)
- **Created:** 2026-11-13
- **Linked PR:** none yet

## Abstract

Today §8.4 lets the submitting principal withdraw an open `ask`. It has two gaps that leave stale work in front of a human. (1) A **task cannot be withdrawn**: §8.4 says "Tasks are not cancellable in v0.3", and that is still true in v0.6. (2) A withdrawal **cannot say why**: §8.4 defines no request body, so the human sees an item vanish, or a bare `cancelled`, with no reason and no pointer to the message that replaced it.

This SCP closes both gaps with **no new resolution value and no new envelope field**:
- (a) §8.4 accepts an optional `comment`. The Hub records it as `response.comment` on the `cancelled` Response.
- (b) The submitting principal may withdraw an open `task`. It lands as `dismissed` with `response.actor` set to the submitting agent, the same shape §7 already uses for `system:undeliverable`.

"This message replaces that one" is carried by (a): withdraw the old message with a comment that names the new message id. No supersede field is added.

## Motivation

Agents change their minds because conditions change: a decision is answered elsewhere, a later message replaces an earlier one, or two senders ask the same question. A stale ask or task is not only noise: a human who acts on one can steer work in a direction that no longer holds.

Implementation evidence (OH HAI, 2026-11-12): an account owner received duplicate and outdated asks on one decision from three agents. Each sender saw the duplicate within minutes. The client offered no withdraw command (that is being fixed client-side), but even with one, a withdrawal could not say "replaced by msg_…" to the human, and a task in the same situation could not be withdrawn at all. So the owner was told "either answer counts".

What the spec has today:
- Asks can be withdrawn (§7, §8.4, submitter-bound per §9.1 and dp-002). A Hub may ignore any body, so a reason cannot reach the human interoperably.
- Tasks cannot be withdrawn by their sender at all. A task that is no longer needed sits open until a human dismisses it or it expires. A human who acts on it does work that no longer helps, or that does harm.

## Specification

**§8.4 Cancel: `POST /v1/messages/{id}/cancel`** (amended)

1. **Scope.** The submitting principal MAY withdraw an open `ask` **or `task`**. The §9.1 binding is unchanged: a cancel from any other principal is refused as if the id were unknown (`404`).
2. **Optional body.** The request MAY carry a JSON body `{ "comment": string }`.
   - The Hub MUST accept a request with no body, an empty body, or `{}`, exactly as today.
   - When `comment` is present, the Hub MUST record it as `response.comment` on the terminal Response it emits.
   - `comment` is subject to the same length bound the Hub applies to a §8.8 resolve `comment`. A longer comment is refused `422 validation_error` and the message stays `open`.
3. **Ask outcome** (unchanged). The ask resolves `cancelled` with `response.actor` = the submitting agent, `agent:<agent.id>` or the session-qualified form under the §8.8 session presentation.
4. **Task outcome** (new). The task resolves **`dismissed`** with `response.actor` = the submitting agent, in the same forms. `response` is present: a withdrawn task carries `actor` and `resolved_at`, plus `comment` when one was given, and never `value`.
   - A reader tells a sender withdrawal from a human dismissal **by the actor**: `agent:*` against `human:*`.
   - This is the same shape §7 uses for `system:undeliverable`.
5. **Races, expiry, idempotency** (unchanged §7 rules, now also for tasks).
   - First terminal wins.
   - A cancel after a different terminal returns `409 already_terminal` with `{ id, status, resolution }`.
   - A cancel strictly after `expires_at` loses to expiry.
   - A repeat cancel of an already withdrawn message returns `200` with the same Response. A different `comment` on the repeat does not change it, because the first terminal is immutable.
6. **Delivery.** The withdrawal emits its terminal Response like a resolve, with push, pull and the §6 session `response` entry unchanged. For an **addressed** message, the addressee's open entry MUST NOT stay actionable. A later §8.8 resolve by the addressee returns `409 already_terminal`, as today.

**§7 Lifecycle** (amended task line):
```
task:     open ──┬─▶ completed   ← human marked done
                 ├─▶ dismissed   ← human declined to act, OR the sender withdrew it (§8.4; actor agent:*)
                 └─▶ expired     ← expires_at passed (no default)
```
The ask line is unchanged. The "single canonical list" of resolution values (§1, §6, §7, §11) is **unchanged**.

**§6 Response:** the `response` presence rule for `task` adds "or to record a §8.4 withdrawal (`actor`, `resolved_at`, optional `comment`)".

**§8.8 table:** the note "`cancelled` is §8.4's verb (submitter-bound)" adds: "a sender's §8.4 withdrawal of a task lands as `dismissed` with an `agent:*` actor; a resolver cannot assert it through §8.8".

**§9.6** (content safety): `response.comment` on a §8.4 withdrawal is **agent-authored** and is untrusted input to whoever reads it, the same as `body`.

**Schema:** no enum changes. `schema/v0.7/response.schema.json` relaxes nothing beyond allowing an `agent:*` actor with no `value` on a `dismissed` task Response, if the current schema forbids it.

## Rationale & alternatives

- **A new resolution value (`withdrawn`, or `cancelled` for tasks):** rejected. It changes the canonical list in four sections and the schema enums, and breaks consumers that switch exhaustively on task resolutions. `dismissed` plus the actor already carries the meaning, and §7 set that precedent with `system:undeliverable`.
- **A `supersedes` / `superseded_by` field:** deferred. A comment naming the new message id gives the human the pointer, and the sender already knows its own chain. Add a machine field only if a reader is shown to need one.
- **Implementer-only, no spec change:** not enough. A Hub may ignore an unspecified body, so the reason would reach the human on some Hubs only. Withdrawing a task is forbidden by the current text, so a conforming Hub cannot offer it.

## Backward compatibility

**MINOR** (v0.7): additive.
- An agent that sends no body gets today's behaviour.
- An agent that never withdraws a task sees nothing new.
- A consumer that reads `dismissed` as "a human declined" should now read the actor too. Before 1.0 that is acceptable under §10; the CHANGELOG calls it out.
- New schema path `schema/v0.7/`, mirroring the v0.6 layout.

## Security considerations

- **Authorization is unchanged and now covers tasks.** Only the submitting principal may withdraw (§9.1, the dp-002 shape). A cross-principal withdraw stays `404`, so a task id cannot be probed by withdrawing it.
- **Shared principals.** Several runs sharing one `agent.id` can withdraw each other's messages: that is the §9.1 principal boundary, as for asks today. A Hub or client MAY narrow this to the submitting session. It is not required here, because session-binding cancel would be a breaking change for agents that resume in a new session (§2.1).
- **Content.** The comment is agent-authored free text shown to a human. It falls under §9.6: bounded length, excluded from telemetry by default, never rendered as markup.
- **Integrity.** `response.comment` and `actor` are already inside the §9.2 / §9.8 detached signatures, so the reason cannot be altered in flight.
- **Abuse.** A sender that withdraws and re-sends to spam is bounded by the existing §8.6 rate limits. Withdrawal removes work from a human; it never adds any.

## Conformance

New vectors:
- **dp-030 task-withdraw-submitter-binding:** A withdraws its own open task: `200`, the task resolves `dismissed` with actor `agent:A`. B's withdraw of A's task: `404`, and the task stays `open`. A withdraw after `completed`: `409 already_terminal`.
- **dp-031 cancel-comment-recorded:** a cancel with `{comment}` yields a Response whose `response.comment` equals it, covered by the signature. A repeat cancel with a different comment returns the first Response unchanged. An over-length comment: `422`, and the message stays `open`.
- **sv-0xx dismissed-task-agent-actor-valid:** a `dismissed` task Response with an `agent:*` actor, a `comment`, and no `value` validates against `schema/v0.7`.

## Reference implementation

To follow. OH HAI's Hub already serves §8.4 for asks (autnmy/oh-hai `server/src/services/resolve.ts` `cancelMessage`). It will add the body and the task path behind this SCP once it is Accepted. A client command for the existing ask cancel ships first, independently, and needs no spec change.

## Unresolved questions

- Should `dismissed` by `agent:*` get a distinct UI label in the spec's guidance ("Withdrawn by the sender")? Proposed: implementer's choice, SHOULD show the comment.
- Should the cancel ack (`200 { id, status }`) echo `resolution` for tasks (`dismissed`)? Proposed: yes, `{ id, status: "dismissed", resolution: "dismissed" }` for a task.

## Future possibilities

- A machine `supersedes` link on submit, if a consumer needs to follow chains automatically.
- A human-side "withdrawn" filter in inbox clients.
