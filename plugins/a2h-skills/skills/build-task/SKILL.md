---
name: Build an A2H task skill
description: Scaffold a custom, app-specific "task" skill so this app's agents can ask a human to perform a manual, out-of-band action via an A2H Hub and learn when it's done. Use when an implementer wants to add A2H task to their app, hand a human a checklist or manual step (rotate a key, flip a setting), or wire the action leg of their app to OH HAI / an A2H Hub.
---

# Build an A2H `task` skill for this app

You are scaffolding a **custom, app-specific `task` skill** that THIS app's agents invoke to hand a human a
**manual action to perform out-of-band** (something the agent can't do itself — rotate a key, flip a
production setting, sign a doc) and get told when it's **done** or **dismissed**. You are the *builder*.

A2H is the Agent-to-Human Protocol — <https://a2hprotocol.org>. `task` shares `ask`'s **response leg** and
its security contract; only the payload and resolution values differ:

- **`idempotency_key` is REQUIRED** (scope `(agent.id, idempotency_key)`), so a retried submit never
  creates a duplicate task.
- **`action`** instead of `request`: `instructions` (what to do), an optional `checklist`, and optional
  `verification` (how the human confirms completion).
- **Resolution** is `completed | dismissed | expired` (no `answered`/`select` semantics).
- **Same signed-callback + resume + agent-sealed `state`** rules as `ask`.

## Steps

### 1. Gather the app's A2H config
Inspect the repo (`AGENTS.md` / `CLAUDE.md` / `.env.example` / config), then ask for what's missing:
- **App name / slug** → names the skill (e.g. `acme-task`).
- **Hub base URL** + **agent auth** — the Hub's advertised `bearer`/`apikey` scheme (env var; never hardcode).
- **Agent identity** — `agent.id` / `run_id` / `runtime` / `project`.
- **Callback strategy** — `push` (verified, agent-owned URL + callback auth: `hmac`/`secret_ref` or
  `bearer`/`apikey`/`token_ref`) **or** `pull` (the agent polls).
- **Resume model** — how a finished run is re-invoked when the task resolves.
- **Signature verifier** *(push only)* — for `push`, the material to **verify** the signed Response for the
  Hub's **advertised algorithm**: a per-agent **shared secret** for `hmac-sha256`, or the Hub's **public key**
  for `ed25519` (capability `signature_algs`). **Pull mode needs none** — trusted via the GET transport.
- **State-seal key** *(if you send `state`)* — a per-`agent.id` secret **pre-positioned in the agent runtime**
  that **survives re-invocation**, is **distinct from the callback credential**, and is **never embedded in
  `state`** — the resumed run uses it to open the sealed blob. (Separate from the response-signature key.)

### 2. Generate the skill
Write `<skills-dir>/<app>-task/SKILL.md` from the template below. For verification + sealing, prefer a
helper built on the A2H reference primitives (`signing.verifyResponse`, `state-seal`) rather than
re-deriving crypto — see the [reference implementation](https://github.com/autnmy/a2h-protocol/tree/main/reference).

### 3. Verify
Smoke-test the full loop: send a test `task`, mark it **done** in the inbox, confirm the agent receives the
Response (**push:** verifies the signature; **pull:** reads the terminal response from the ack's `poll_url`),
sees `resolution: "completed"`, and acts **once** (a replay is a no-op).

### 4. Hand off
Document how agents invoke it, the callback/resume wiring, and required secrets.

### 5. (Optional) Package as a plugin for your team
If other people's agents should also send to this Hub, offer to package the generated skill(s) as an
**installable plugin** in this repo. Plugin skills live under the **plugin root** — put each generated skill
at `<plugin-root>/skills/<app>-task/SKILL.md` (move it there from `.claude/skills/`, or point the plugin's
`skills` path at its location), then add `.claude-plugin/plugin.json` and a root
`.claude-plugin/marketplace.json` listing it (bundle whichever verb skills the app exposes — notify/ask/task).
Teammates run `/plugin marketplace add <this-repo>` → `/plugin install <app>-a2h@<marketplace>` and use
`/<app>-task`. Validate with `claude plugin validate .`.

## Template — the generated `<app>-task` skill

````markdown
---
name: <APP> task
description: Ask a human to perform a manual, out-of-band action via <APP>'s A2H Hub and learn when it's done. Use when an agent needs a human to do something it can't do itself before continuing.
---

# Ask a human to do a task (A2H `task`)

## Send
- **Endpoint:** `POST <HUB_URL>/v1/messages`  ·  **Auth:** the Hub's advertised scheme (capability `auth_schemes`) — `Authorization: Bearer $<AUTH_ENV>` for `bearer`, or the API-key header for `apikey`

**Envelope** (`type: "task"`):
- `a2h_version`: `"0.2"`, `created_at`: ISO now
- `agent`: `{ "id": "<AGENT_ID>", "run_id": "<RUN_ID>", "runtime": "<RUNTIME>", "project": "<PROJECT>" }`  *(every value is a JSON string — keep the quotes)*
- `title`, `body` (Markdown), `priority?`, `tags?`
- **`idempotency_key`** (REQUIRED): stable per logical task.
- `action`:
  - `instructions`: what the human must do (Markdown)
  - `checklist` *(optional)*: `[{ "text": "…", "done": false }, …]`
  - `verification` *(optional)*: how completion is confirmed
  - **`allowed_resolvers` (REQUIRED for a human task)**: list the **concrete human actor id(s)** allowed to
    complete it — e.g. `["human:alice"]` (format `<type>:<id>`; the Hub matches the resolver **exactly —
    there is no wildcard**). If omitted it **fails closed to the submitting `agent.id` only** — so no human
    can resolve the task and it sits unresolvable until it expires.
  - `callback`: `{ "mode": "push", "url": "<CALLBACK_URL>", "auth": { "scheme": "<hmac|bearer|apikey>", "<secret_ref|token_ref>": "…" } }` — or `{ "mode": "pull" }`.
- `state` *(optional)*: an **agent-sealed** (AEAD) resume blob; the Hub stores it opaquely.

Expect `202 { id, status: "open" }`. Retries reuse the **same `idempotency_key`** → same `id`, no duplicate.

## Receive (resume)
The run may end here. When the human resolves it, the agent gets the terminal Response one of two ways:

- **push:** the Hub `POST`s a **signed Response** to `<CALLBACK_URL>` → your handler re-invokes this agent.
- **pull:** poll the **`poll_url` returned in the `202` ack** (with the Hub's advertised auth header) until the message reaches a terminal
  state; the terminal `response` is **embedded in the message body** (use the ack's `poll_url` verbatim —
  the Hub may sit behind a path prefix). A pull response is **not** signed — it's trusted
  via the authenticated GET transport + the immutable terminal record (no `jti` / detached signature).

Then **MUST**:
1. **(push only) Verify** the signature: recompute RFC 8785 JCS over the `signed_context`, verify the
   detached `A2H-Signature: t=<unix>,jti=<nonce>,v1=<base64url(sig)>` with the Hub's **advertised algorithm**
   (`hmac-sha256` per-agent key, or `ed25519` — see capability `signature_algs`), the `jti`
   nonce, the ±120s window (`t`), and the binding to `id` + `resolution_id` + `callback_url`. Reject on any
   mismatch. **Pull skips this step** — just read the terminal `response`.
2. **Dedupe** on `(in_reply_to, resolution_id)` (where `in_reply_to` is the message `id`) and **act at most
   once**.
3. If you sent `state`, **verify + open** it (AEAD) before trusting it.
4. Read the outcome: `resolution ∈ { completed | dismissed | expired }`. A `task` Response carries
   `response.comment` and/or the final `checklist` state — there is **no `response.value`** (that field is
   reserved for `ask`).

Use the A2H reference (`signing.verifyResponse`, `state-seal.openState`) for steps 1 (push) and 3.
````

## References
- Spec: <https://a2hprotocol.org/spec/v0.2.md> (§5 verbs, §6 response, §7 lifecycle, §9 security)
- Schemas: <https://a2hprotocol.org/schema/v0.2/message.schema.json> · <https://a2hprotocol.org/schema/v0.2/response.schema.json>
- Reference impl (verify/seal): <https://github.com/autnmy/a2h-protocol/tree/main/reference>
