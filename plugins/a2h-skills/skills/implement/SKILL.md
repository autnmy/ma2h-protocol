---
name: Implement an A2H Hub
description: Implement a conformant A2H Hub in your app — the server side that receives notify/ask/task from agents, presents them to a human for triage, and signs + routes the response back to the (often-exited) agent. Stack-agnostic: works in any language or framework (Node, Python, Go, Ruby, Rust, …). Use when implementing the A2H protocol, building an A2H Hub, or adding an agent-to-human inbox endpoint to your app. Triggers: "implement A2H", "build an A2H hub", "add an agent inbox to my app", "make my app speak A2H".
---

# Implement an A2H Hub in this app

You are implementing the **server side** of the [A2H protocol](https://a2hprotocol.org) — a **Hub**: the
endpoint that **receives** `notify` / `ask` / `task` from agents, presents them to a human to triage, and
**signs + routes the response** back to the agent. This is the protocol implementation, the receiver.

You are **not** building the sender side here. Agents *calling* a Hub is a separate concern — once this Hub
is up, run `build-notify` / `build-ask` / `build-task` to wire an app's agents to send to it.

**You bring the protocol; the implementer brings the stack.** Do not assume a language or framework — read
the project (its language, web framework, datastore, auth, deploy target) and map the protocol onto it.
Your definition of done is **conformance**, not a copied reference implementation.

## 0. Ground yourself in the spec

Read these before writing code — they are the source of truth:
- **Spec:** <https://a2hprotocol.org/spec/v0.2.md> (§5 verbs · §6 response · §7 lifecycle · §8 transport · §9 security)
- **Schemas:** <https://a2hprotocol.org/schema/v0.2/message.schema.json> · `response.schema.json` · `capability.schema.json` · `submit-ack.schema.json` · `get-message.schema.json`
- **Reference impl** (the crypto/lifecycle, to mirror — see §3): <https://github.com/autnmy/a2h-protocol/tree/main/reference>
- **Conformance vectors** (your tests): <https://github.com/autnmy/a2h-protocol/tree/main/conformance>

## 1. Understand the project

Inspect the repo and confirm with the implementer:
- **Language + web framework** (e.g. Express, FastAPI, Rails, Gin, Axum).
- **Datastore** for messages/resolutions/outbox (Postgres, SQLite, Mongo, …).
- **Auth** model for agents (bearer) and the human triage surface.
- **Deploy/runtime** (so callback delivery + any background worker fit).
- Whether the human triage UI is in scope here or built separately (the Hub's job is the API + lifecycle; a UI consumes it).

## 2. The required surface

Implement these (paths are conventional — match the spec's shapes, adapt routing to the framework):

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/messages` | ingest `notify`/`ask`/`task`; **Hub assigns `id`**; returns `202` + ack |
| GET | `/v1/messages` · `/v1/messages/{id}` | inbox read; reads are **idempotent**; **pull-mode** clients read the signed terminal Response **embedded in the message body** of `GET /v1/messages/{id}` |
| POST | `/v1/messages/{id}/resolve` | a human resolves an `ask`/`task` → triggers the signed response |
| POST | `/v1/messages/{id}/cancel` | the agent withdraws an open `ask` → `cancelled` |
| GET | `/.well-known/a2h` | advertise limits + supported auth schemes (standardized discovery) |
| GET | `/v1/stream` *(optional)* | SSE live tail for a live inbox |

## 3. The Hub MUSTs — your definition of done

Every one of these is normative. The implementation is not done until each is satisfied **and** covered by
a test. (This is the same checklist the conformance vectors enforce.)

- [ ] **`id` is Hub-assigned**, never a client input. Clients correlate via `client_ref` (opaque; never a dedup key; never shown to resolvers).
- [ ] **Idempotency:** `idempotency_key` is **required** for `ask`/`task`; dedup scope `(agent.id, idempotency_key)` → a retry with an **identical payload** returns the same `id`, never a second row/decision. Reusing the **same key with a different payload** MUST return **`409 Conflict`** (never silently the original `id`).
- [ ] **`state` is agent-owned + sealed:** opaque AEAD blob; the **Hub MUST NOT inspect, log, or hold the key**; returned **verbatim** on resolution.
- [ ] **Every pushed Response is signed:** RFC 8785 **JCS** over the `signed_context` + a **detached HMAC-SHA256**, with a `jti` nonce, a ±120s window, and binding to `id` + `resolution_id` + `callback_url`.
- [ ] **`actor` is Hub-attested** from the authenticated session — never the resolving request body; format `<type>:<id>`, `type ∈ {human, agent, system}`.
- [ ] **Resolver authz is fail-closed** (`allowed_resolvers` defaults closed).
- [ ] **Callbacks** target an **agent-owned, verified** host (push or pull) with **SSRF controls**: host-ownership verification, private-range refusal at delivery time, no redirects, credential-host binding. The Hub **MUST NOT** server-side-fetch `context.file.uri` unless that URI passes the **same host controls used for callbacks**.
- [ ] **Lifecycle** is atomic, single-writer, **first-terminal-wins**. Resolutions: `ask` → `answered|declined|cancelled|expired`; `task` → `completed|dismissed|expired`. Statuses: `delivered` is terminal-on-acceptance for **`notify` only** (`open` → `delivered`); `ask`/`task` transition **`open` → terminal** directly (no `delivered` state).
- [ ] **`body` is untrusted Markdown** — sanitize to a **no-raw-HTML** profile before any rendering.
- [ ] **Telemetry/logs exclude** `state`, `body`, `context`, `response.value`, `response.comment` — `state` is a hard **MUST NOT log** (the agent's opaque resume context).
- [ ] **Capability discovery** advertises `max_body_bytes` / `max_part_bytes` / `max_context_parts` / auth schemes, and the Hub **enforces** those limits at ingest.
- [ ] **Submit returns `202`; GET reads are idempotent** (a terminal message returns the same body).

## 4. Do not hand-roll the crypto

JCS canonicalization, the detached HMAC signature, and the AEAD state-seal are exact and easy to get
subtly wrong. **Port or mirror the [reference primitives](https://github.com/autnmy/a2h-protocol/tree/main/reference)**
(`canonicalize`, `signing`, `state-seal`, `lifecycle`) into the project's language, matching their
algorithms byte-for-byte — then prove it with the `dp-001` signature vector. Never invent your own framing.

## 5. Implement

Validate inbound envelopes against the JSON Schemas at the boundary. Build the surface (§2), satisfy each
MUST (§3), wire a small **callback outbox + delivery worker** for push (with the SSRF controls) and the
pull endpoint. Keep the human-facing rendering separate from the API.

## 6. Prove conformance — then you're done

Run the **conformance vectors** against the implementation and add Hub scenario tests for each invariant
(idempotency dedup, first-terminal-wins, signed-callback round-trip + verify, SSRF refusal, fail-closed
authz, body sanitization). Wire them into CI. **You are not done until they pass.** That is the bar — in
any language.

## 7. Hand off

Tell the implementer: the Hub is up at `<base-url>` with `<auth>`. **To let agents send to it, run
`build-notify` / `build-ask` / `build-task`** in the apps whose agents should reach this Hub.

## References
- A2H: <https://a2hprotocol.org> · Spec: <https://a2hprotocol.org/spec/v0.2.md>
- Schemas: <https://a2hprotocol.org/schema/v0.2/message.schema.json>
- Reference impl + conformance: <https://github.com/autnmy/a2h-protocol/tree/main/reference> · <https://github.com/autnmy/a2h-protocol/tree/main/conformance>
