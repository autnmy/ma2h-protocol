---
name: build-ask
description: Scaffold a custom, app-specific "ask" skill so this app's agents can ask a human a decision via an A2H Hub and get the signed answer routed back. Use when an implementer wants to add A2H ask to their app, let agents request a human decision (approve/select/input), or wire the decision leg of their app to OH HAI / an A2H Hub.
---

# Build an A2H `ask` skill for this app

You are scaffolding a **custom, app-specific `ask` skill** that THIS app's agents invoke to put a
**decision** in front of a human via the app's A2H Hub, and have the **signed answer routed back** — even
if the agent run has already exited. You are the *builder*: you produce the skill.

A2H is the Agent-to-Human Protocol — <https://a2hprotocol.org>. Unlike `notify`, `ask` has a **response
leg**, which makes it the most involved verb. Get these right in the generated skill:

- **`idempotency_key` is REQUIRED** — stable per logical request, scope `(agent.id, idempotency_key)`, so a
  lost `202` retried doesn't create a second human decision.
- **`callback`** — where the answer goes: `push` (the Hub `POST`s the signed Response to your URL) or
  `pull` (your agent polls the `poll_url` from the `202` ack and reads the terminal `response` embedded in
  the message body).
- **Resume + verify** — the run may end; on the callback it is re-invoked. **Only pushed Responses are
  signed** (`A2H-Signature: t=<unix>,jti=<nonce>,v1=<base64url(sig)>` — RFC 8785 JCS + detached
  HMAC-SHA256, ±120s window, bound to `id` + `resolution_id` + `callback_url`); a **pull** response is
  trusted via the authenticated GET transport + the immutable terminal record, with no detached signature.
  The agent **MUST verify the signature on push, dedupe on `(in_reply_to, resolution_id)`, and act at most
  once**.
- **`state`** — any resume context is **agent-owned and sealed by the agent** (AEAD); the Hub never holds
  the key and returns it verbatim. Seal before sending; verify + open on resume. Never put the key in `state`.

## Steps

### 1. Gather the app's A2H config
Inspect the repo (`AGENTS.md` / `CLAUDE.md` / `.env.example` / config), then ask for what's missing:
- **App name / slug** → names the skill (e.g. `acme-ask`).
- **Hub base URL** + **agent auth** — the Hub's advertised `bearer`/`apikey` scheme (env var; never hardcode).
- **Agent identity** — `agent.id` / `run_id` / `runtime` / `project`.
- **Callback strategy** — `push` (your app exposes a verified, agent-owned URL + a callback auth scheme:
  `hmac` via `secret_ref`, or `bearer`/`apikey` via `token_ref`) **or** `pull` (the agent polls). Pick
  `pull` if the app can't expose an inbound URL.
- **Resume model** — how a finished run is re-invoked on the answer (queue, webhook handler, cron poll).
- **Signature verifier** *(push only)* — for `push`, the material to **verify** the signed Response for the
  Hub's **advertised algorithm**: a per-agent **shared secret** for `hmac-sha256`, or the Hub's **public key**
  for `ed25519` (capability `signature_algs`) — distinct from any callback transport credential. **Pull mode
  needs none** — the terminal response is trusted via the authenticated GET transport.
- **State-seal key** *(if you send `state`)* — a per-`agent.id` secret **pre-positioned in the agent runtime**
  (a CI/Actions secret, a vault env var) that **survives re-invocation**, is **distinct from the callback
  credential**, and is **never embedded in `state`** — the resumed run uses it to open the sealed blob.
  (This is separate from the response-signature key above; provision it whenever the skill resumes via `state`.)

### 2. Generate the skill
Write `<skills-dir>/<app>-ask/SKILL.md` from the template below. For verification + sealing, prefer a small
helper that uses the A2H reference primitives (`canonicalize`, `signing.verifyResponse`, `state-seal`) —
see the [reference implementation](https://github.com/autnmy/a2h-protocol/tree/main/reference) — rather
than re-deriving crypto.

### 3. Verify
Smoke-test the full loop: send a test `ask`, resolve it in the inbox, confirm the agent receives the
Response (**push:** verifies the signature; **pull:** reads the terminal response from the ack's `poll_url`,
no signature), reads the outcome, and acts **once** (a replayed delivery is a no-op).

### 4. Hand off
Document how agents invoke it, the callback/resume wiring, and required secrets.

### 5. (Optional) Package as a plugin for your team
If other people's agents should also send to this Hub, offer to package the generated skill(s) as an
**installable plugin** in this repo. Plugin skills live under the **plugin root** — put each generated skill
at `<plugin-root>/skills/<app>-ask/SKILL.md` (move it there from `.claude/skills/`, or point the plugin's
`skills` path at its location), then add `.claude-plugin/plugin.json` and a root
`.claude-plugin/marketplace.json` listing it (bundle whichever verb skills the app exposes — notify/ask/task).
Teammates run `/plugin marketplace add <this-repo>` → `/plugin install <app>-a2h@<marketplace>` and invoke
it as `/<app>-a2h:<app>-ask` (plugin skills are namespaced `/<plugin>:<skill>`). Validate with `claude plugin validate .`.

## Template — the generated `<app>-ask` skill

````markdown
---
name: <app>-ask
description: Ask a human a decision via <APP>'s A2H Hub and route the signed answer back to the agent. Use when an agent needs a human choice (approve/select/input) before it can proceed.
---

# Ask a human a decision (A2H `ask`)

## Send
- **Endpoint:** `POST <HUB_URL>/v1/messages`  ·  **Auth:** the Hub's advertised scheme (capability `auth_schemes`) — `Authorization: Bearer $<AUTH_ENV>` for `bearer`, or the API-key header for `apikey`

**Envelope** (`type: "ask"`):
- `a2h_version`: `"0.2"`, `created_at`: ISO now
- `agent`: `{ "id": "<AGENT_ID>", "run_id": "<RUN_ID>", "runtime": "<RUNTIME>", "project": "<PROJECT>" }`  *(every value is a JSON string — keep the quotes)*
- `title`, `body` (Markdown), `priority?`, `tags?`
- **`idempotency_key`** (REQUIRED): stable per logical request (e.g. a hash of the decision context).
- `request`: the decision shape — one of:
  - `{ "mode": "confirm", "options": [{"value":"yes","label":"…"},{"value":"no","label":"…"}] }`
  - `{ "mode": "select", "options": [{"value":"a","label":"…"}, …] }`  (≥1 option)
  - `{ "mode": "input", "schema": { …flat JSON Schema: string/number/boolean/enum… } }`
- **`request.allowed_resolvers` (REQUIRED for a human decision)**: list the **concrete human actor id(s)**
  allowed to answer — e.g. `["human:alice"]` (format `<type>:<id>`, `type ∈ {human,agent,system}`; the Hub
  matches the authenticated resolver **exactly — there is no wildcard**). If omitted it **fails closed to
  the submitting agent's own actor `agent:<agent.id>` only** (resolvers compare in `<type>:<id>` form, not
  the raw id) — so no human can resolve the ask and it sits unresolvable until it expires.
- `request.callback`: `{ "mode": "push", "url": "<CALLBACK_URL>", "auth": { "scheme": "<hmac|bearer|apikey>", "<secret_ref|token_ref>": "…" } }` — or `{ "mode": "pull" }`.
- `state` *(optional)*: an **agent-sealed** (AEAD) resume blob. Seal it yourself; the Hub stores it opaquely.

Expect `202` with `{ id, status: "open", poll_url }` — **persist `poll_url`** (pull mode polls it to resume). If a `202` is lost, **persist the exact submitted envelope and replay it byte-for-byte** (same
`idempotency_key` **and** same `created_at`) — you'll get the same `id` back, never a duplicate decision.
Do **not** rebuild the envelope with a fresh `created_at`: the same key with a **different** payload is a
`409` (§8.1), not the original decision.

## Receive (resume)
The run may end here. When the human resolves it, the agent gets the terminal Response one of two ways:

- **push:** the Hub `POST`s a **signed Response** to `<CALLBACK_URL>` — your handler re-invokes this agent.
- **pull:** poll the **`poll_url` returned in the `202` ack** (with the Hub's advertised auth header) until the message reaches a terminal
  state; the terminal `response` is **embedded in the message body**. Use the ack's `poll_url` verbatim —
  the Hub may sit behind a path prefix, so don't reconstruct the URL. A pull response is **not** signed —
  it's trusted via the authenticated GET transport + the immutable terminal record (no `jti` / detached signature).

Then **MUST**:
1. **(push only) Verify** the signature: recompute RFC 8785 JCS over the `signed_context`, verify the
   detached `A2H-Signature: t=<unix>,jti=<nonce>,v1=<base64url(sig)>` with the Hub's **advertised algorithm**
   (`hmac-sha256` with the per-agent key, or `ed25519` — see capability `signature_algs`), the `jti`
   nonce (not seen before), the ±120s window (`t`), and the binding to `id` + `resolution_id` +
   `callback_url`. Reject on any mismatch. **Pull skips this step** — just read the terminal `response`.
2. **Dedupe** on `(in_reply_to, resolution_id)` (where `in_reply_to` is the message `id`) and **act at most
   once** (callbacks may be delivered more than once).
3. If you sent `state`, **verify + open** it (AEAD) before trusting it.
4. Read the outcome by **`resolution` first** (`answered | declined | cancelled | expired`). `response.value`
   is present for **`answered`** (the human's answer, shape matches `request`) **and for a defaulted
   `expired`** (`defaulted: true` ⇒ `value` is the `default_on_expire` choice, `actor:
   "system:default_on_expire"`). For `declined` / `cancelled` / a **non-defaulted** `expired` there is **no
   `response.value`** — branch on the resolution and **don't treat a missing value as an error**.
   `response.comment` + `actor` may still be present.

Use the A2H reference (`signing.verifyResponse`, `state-seal.openState`) for steps 1 (push) and 3 — but
note `signing.verifyResponse` implements **`hmac-sha256` only** in v0.2; if the Hub advertises **`ed25519`**,
verify the detached signature over the same JCS `signed_context` with your platform's ed25519 primitive,
**not** that helper (it returns `alg not implemented: ed25519`).
````

## References
- Spec: <https://a2hprotocol.org/spec/v0.2.md> (§5 verbs, §6 response, §7 lifecycle, §9 security)
- Schemas: <https://a2hprotocol.org/schema/v0.2/message.schema.json> · <https://a2hprotocol.org/schema/v0.2/response.schema.json>
- Reference impl (verify/seal): <https://github.com/autnmy/a2h-protocol/tree/main/reference>
