---
name: implement
description: >-
  Implement a conformant MA2H Hub in your app — the server side that receives notify/ask/task from agents,
  presents them to a human for triage, and signs + routes the response back to the (often-exited) agent.
  Stack-agnostic: works in any language or framework (Node, Python, Go, Ruby, Rust, …). Use when
  implementing the MA2H protocol, building an MA2H Hub, or adding an agent-to-human inbox endpoint to your
  app. Triggers: "implement MA2H", "implement A2H", "build an MA2H hub", "build an A2H hub", "add an agent inbox to my app", "make my app speak MA2H", "make my app speak A2H".
---

# Implement an MA2H Hub in this app

You are implementing the **server side** of the [MA2H protocol](https://ma2h.org) — a **Hub**: the
endpoint that **receives** `notify` / `ask` / `task` from agents, presents them to a human to triage, and
**signs + routes the response** back to the agent. This is the protocol implementation, the receiver.

You are **not** building the sender side here. Agents *calling* a Hub is a separate concern — once this Hub
is up, run `build-notify` / `build-ask` / `build-task` to wire an app's agents to send to it, and
`build-inbox` to wire an agent to drain the human→agent directives this Hub delivers.

**v0.4 adds an optional inbound leg** (human→agent **directives**, §13). It is **additive and OPTIONAL**:
build the agent→human core (§2–§5) first; add the inbound leg (§6) only if this Hub should let a human send
an instruction to a specific agent. A Hub that omits it stays fully conformant and simply does not advertise
`inbound` in its capability document.

**You bring the protocol; the implementer brings the stack.** Do not assume a language or framework — read
the project (its language, web framework, datastore, auth, deploy target) and map the protocol onto it.
Your definition of done is **conformance**, not a copied reference implementation.

## 0. Ground yourself in the spec

Read these before writing code — they are the source of truth:
- **Spec:** <https://ma2h.org/spec/v0.4.md> (§5 verbs · §6 response · §7 lifecycle · §8 transport · §9 security · **§13 inbound directives**)
- **Schemas:** <https://ma2h.org/schema/v0.4/message.schema.json> · `response.schema.json` · `capability.schema.json` · `submit-ack.schema.json` · `get-message.schema.json` · `inbound-message.schema.json` *(v0.4 directive)*
- **Reference impl** (the crypto/lifecycle, to mirror — see §3): <https://github.com/autnmy/ma2h-protocol/tree/main/reference>
- **Conformance vectors** (your tests): <https://github.com/autnmy/ma2h-protocol/tree/main/conformance>

## 1. Understand the project

Inspect the repo and confirm with the implementer:
- **Language + web framework** (e.g. Express, FastAPI, Rails, Gin, Axum).
- **Datastore** for messages/resolutions/outbox (Postgres, SQLite, Mongo, …).
- **Auth** model for agents (bearer) and the human triage surface.
- **Deploy/runtime** (so callback delivery + any background worker fit).
- Whether the human triage UI is in scope here or built separately (the Hub's job is the API + lifecycle; a UI consumes it).

## 2. The required surface

Implement these over **HTTPS only** (plaintext MUST NOT be offered, §8). Paths are conventional — match the spec's shapes, adapt routing to the framework:

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/messages` | ingest `notify`/`ask`/`task`; **Hub assigns `id`**; returns `202` + the submit-ack body **including `poll_url`** (the canonical per-message URL clients poll) |
| GET | `/v1/messages` · `/v1/messages/{id}` | inbox read; reads are **idempotent**; **pull-mode** clients read the terminal Response **embedded in the message body** of `GET /v1/messages/{id}` — trusted via the authenticated GET transport, **not signed** |
| POST | `/v1/messages/{id}/resolve` | a human resolves an `ask`/`task` → triggers the signed response |
| POST | `/v1/messages/{id}/cancel` | the agent withdraws an open `ask` → terminal `cancelled`, which **emits a terminal Response** delivered like a resolve (push and/or embedded for pull) so the agent gets closure |
| GET | `/.well-known/ma2h` | advertise limits + supported auth schemes (standardized discovery) |
| GET | `/v1/stream` *(optional)* | SSE live tail for a live inbox |

## 3. The Hub MUSTs — your definition of done

Every one of these is normative. This is the **load-bearing map, not an exhaustive restatement** — the
linked spec sections and the **conformance vectors are the contract**. Treat the vectors as the bar: the
implementation is done when each MUST below holds **and** the vectors pass.

- [ ] **`id` is Hub-assigned**, never a client input. Clients correlate via `client_ref` (opaque; never a dedup key; never shown to resolvers).
- [ ] **Idempotency:** `idempotency_key` is **required** for `ask`/`task`; dedup scope `(agent.id, idempotency_key)` → a retry with an **identical payload** returns the same `id`, never a second row/decision. Reusing the **same key with a different payload** MUST return **`409 Conflict`** (never silently the original `id`).
- [ ] **`state` is agent-owned + sealed:** opaque AEAD blob; the **Hub MUST NOT inspect, log, or hold the key**; returned **verbatim** on resolution.
- [ ] **Every pushed Response is signed:** RFC 8785 **JCS** over the `signed_context` + a **detached signature** — `hmac-sha256`, or `ed25519` if the Hub advertises it in capability `signature_algs` (§9.2) — with a `jti` nonce, a ±120s window, and binding to `id` + `resolution_id` + `callback_url` + **`payload_sha256`** (v0.3 binds the response payload — the lowercase-hex SHA-256 of the JCS of `{ response, state }` — so a terminating proxy can't flip `response.value`; §9.2). Because this signature break is at the **push** leg, a Hub MUST reject a **push** callback requested at a **pre-0.3** `ma2h_version` with `version_not_supported` (pull stays compatible; §10).
- [ ] **`actor` is Hub-attested** from the authenticated session — never the resolving request body; format `<type>:<id>`, `type ∈ {human, agent, system}`.
- [ ] **Resolver authz is fail-closed** (`allowed_resolvers` absent ⇒ only the submitting agent's actor **`agent:<agent.id>`** may resolve — actors compare in `<type>:<id>` form, never the raw id).
- [ ] **Request-leg auth** (§9.1): the agent credential is scoped to one `agent.id` — **reject an envelope whose `agent.id` ≠ the credential (`403`)**, and **bind each message's poll, callback, AND cancel access to the submitting principal** (one agent must not read — or `POST /v1/messages/{id}/cancel` to terminally withdraw — another's message by `id`); `run_id` is opaque and **MUST NOT** authorize cross-run access.
- [ ] **Callbacks** target an **agent-owned, verified** host (push or pull) with **SSRF controls**: host-ownership verification, private-range refusal at delivery time, no redirects, credential-host binding. The Hub **MUST NOT** server-side-fetch `context.file.uri` unless that URI passes the **same host controls used for callbacks**.
- [ ] **Lifecycle** is atomic, single-writer, **first-terminal-wins**. Resolutions: `ask` → `answered|declined|cancelled|expired`; `task` → `completed|dismissed|expired`. Statuses: `delivered` is terminal-on-acceptance for **`notify` only** (`open` → `delivered`); `ask`/`task` transition **`open` → terminal** directly (no `delivered` state).
- [ ] **Expiry & defaults** (§7, §8.5): reject `expires_at` not in the future at submit (`422`); **validate `default_on_expire` at submit** — a member of `options[].value` for `select`, an object matching the `input` schema, or `null` — and reject a bad default with `422` **up front** (never defer the error to expiry); when `expires_at` passes with no human action, auto-resolve `expired` — for `ask`, apply `default_on_expire` as a Response with `defaulted: true` and `actor: "system:default_on_expire"`; `task` has no default (bare `expired`).
- [ ] **Durable persistence** (§3.1): a Hub process restart **MUST NOT** lose open asks/tasks, delivered notifies, committed resolutions, or pending push-delivery obligations. **In-memory-only storage is non-conformant** — back the lifecycle with a real store and add a restart test.
- [ ] **`body` is untrusted Markdown** — sanitize to a **no-raw-HTML** profile **and do not auto-fetch remote images** (disable or proxy `![](http…)`) before any rendering, so rendering can't leak the resolver's IP/network info (§9.6).
- [ ] **Telemetry/logs exclude** `state`, `body`, `context`, `response.value`, `response.comment` — `state` is a hard **MUST NOT log**. Also exclude any value marked **`x-ma2h-sensitive: true`** (an `input`-schema property) or under a message-level **`sensitive: true`**, wherever it is nested.
- [ ] **Capability discovery** advertises `max_body_bytes` / `max_part_bytes` / `max_context_parts` / auth schemes, and the Hub **enforces** those limits at ingest.
- [ ] **Submit returns `202`; GET reads are idempotent** (a terminal message returns the same body), and a **resolved message stays pull-available for the advertised retention TTL** (§8.2, RECOMMENDED 30 days) — do **not** purge terminal records at resolution, or a pull-only / missed-push agent's `poll_url` `404`/`410`s before it reads the embedded Response (a **deleted** message returns `410 Gone`; an **unknown** id `404`).

## 4. Do not hand-roll the crypto

JCS canonicalization, the detached HMAC signature, and the AEAD state-seal are exact and easy to get
subtly wrong. **Port or mirror the [reference primitives](https://github.com/autnmy/ma2h-protocol/tree/main/reference)**
(`canonicalize`, `signing`, `state-seal`, `lifecycle`) into the project's language, matching their
algorithms byte-for-byte — then prove it with the `dp-001` signature vector. Never invent your own framing.

## 5. Implement

Validate inbound envelopes against the JSON Schemas at the boundary. Build the surface (§2), satisfy each
MUST (§3), and wire a small **callback outbox + delivery worker** for push. Delivery is **at-least-once**
(§8.3): retry on `5xx`/network errors with exponential backoff (**≥ 5 attempts**), **never** retry on `4xx`,
cap total attempts + duration (and advertise it), apply the SSRF controls on every attempt, and after
retry exhaustion keep the resolution **pull-available** — it is never lost. Keep the human-facing rendering
separate from the API.

## 6. (Optional) The inbound leg — human → agent directives (v0.4, §13)

Add this only if a human should be able to **send a message to a specific agent** through this Hub. It is
**additive** — it changes nothing above. A Hub-attested `human:<id>` authors a **directive** addressed to
one `agent:<id>`; the agent drains it from a **durable per-agent mailbox** and verifies a detached Hub
signature (the inbound mirror of §9.2). Reuse the crypto you already built (§4) — same RFC 8785 JCS, same
detached-signature framing, same `jti`.

**Two agent-facing endpoints** (bearer-authenticated; the credential's `agent.id` selects the mailbox):

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/inbox` | drain up to `?max=N` pending directives (FIFO), each paired with its `MA2H-Signature`; supports `?wait=<seconds>` long-poll like `GET /v1/messages/{id}` |
| POST | `/v1/inbox/ack` | `{ "ids": [...] }` — consume (remove) processed directives; idempotent |

Plus a **human-facing authoring action** (Hub-internal, like `/…/resolve` — *not* a normative agent wire
path): the human picks an agent and composes a directive; the Hub attests `from`, assigns `id`, and enqueues
it. And advertise the leg in the capability document.

**Inbound Hub MUSTs** (§8.7, §9.7, §13 — the `dp-005`/`dp-006`/`dp-007` vectors are the bar):

- [ ] **`from` is Hub-attested** (`^(human|system):.+$`) from the authoring session, never a request field — exactly as `actor` is attested (§9.1). **`to`** is the addressed `agent:<id>`; the Hub assigns `id`. Reject a directive whose `ma2h_version` minor is `< 4`, or a past `expires_at` (`422`), at author time.
- [ ] **Durable, FIFO, per-`agent.id` mailbox.** Delivery is **at-least-once**: a drained directive is invisible for a visibility window, then **redelivered** if unacked; **ack** removes it. Isolation: a principal drains/acks **only its own** mailbox (a foreign id is indistinguishable from unknown) — the §9.1 submitter-binding, applied to the inbox.
- [ ] **Sign every delivery (§9.7).** Detached signature over JCS of `inbound_signed_context = { from, id, jti, ma2h_version, payload_sha256, t, to }`, where `payload_sha256` = lowercase-hex SHA-256 of JCS(`{ "directive": <title/body/priority/tags/context present> }`). **Re-sign per delivery** with a fresh `t`/`jti` so a directive resting in the mailbox stays inside the agent's replay window. Binding `to` stops cross-agent replay.
- [ ] **Retention/expiry (§13.3).** Keep an unacked directive drainable until acked or `expires_at`/`inbound.retention_days` passes, then **drop** it (no Response leg — a directive is the `notify` mirror). Un-acked directives + pending directive-webhook obligations **survive restart** (§3.1).
- [ ] **Optional webhook.** MAY push each signed directive to a pre-registered, **§9.4-verified** agent callback with the same §8.3 at-least-once retry rules; the mailbox stays the source of truth.
- [ ] **Advertise** an `inbound` object in `GET /.well-known/ma2h`: `{ enabled, poll_url, ack_url, max_batch, visibility_timeout_seconds, retention_days, signature_algs, webhook_supported }`. A Hub without the leg **omits** it.

The agent side (verify the §9.7 signature, validate shape, confirm `to` is itself, dedup on `id`, ack after
durable processing) is scaffolded by **`build-inbox`** — not your job here.

## 7. Prove conformance — then you're done

Run the **conformance vectors** against the implementation and add Hub scenario tests for each invariant
(idempotency dedup, first-terminal-wins, signed-callback round-trip + verify, SSRF refusal, fail-closed
authz, body sanitization; and if you built §6: directive signing/verify `dp-005`, tamper/cross-agent-replay
`dp-006`, and mailbox at-least-once/consume/isolation `dp-007`). Wire them into CI. **You are not done until
they pass.** That is the bar — in any language.

## 8. Hand off

Tell the implementer: the Hub is up at `<base-url>` with `<auth>`. **To let agents send to it, run
`build-notify` / `build-ask` / `build-task`**; if you built the inbound leg (§6), **run `build-inbox`** in
the apps whose agents should drain human→agent directives from this Hub.

## References
- MA2H: <https://ma2h.org> · Spec: <https://ma2h.org/spec/v0.4.md>
- Schemas: <https://ma2h.org/schema/v0.4/message.schema.json>
- Reference impl + conformance: <https://github.com/autnmy/ma2h-protocol/tree/main/reference> · <https://github.com/autnmy/ma2h-protocol/tree/main/conformance>
