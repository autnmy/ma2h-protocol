---
name: Build an A2H notify skill
description: Scaffold a custom, app-specific "notify" skill so this app's agents can send fire-and-forget A2H notifications (digests, status, FYIs) to a human via an A2H Hub. Use when an implementer wants to add A2H notify to their app, give their agents a way to post notifications, or wire their app to OH HAI / an A2H Hub.
---

# Build an A2H `notify` skill for this app

You are scaffolding a **custom, app-specific `notify` skill** that THIS app's agents will invoke to send
an A2H **notify** (FYI / summary / status — no response) to the app's A2H Hub. You are the *builder*: you
produce the skill; you do not send notifications yourself.

A2H is the Agent-to-Human Protocol — <https://a2hprotocol.org>. `notify` is **fire-and-forget**: post the
message, get `202`, done. No callback, no resume, no idempotency key required.

## Steps

### 1. Gather the app's A2H config
Inspect the repo first (`AGENTS.md` / `CLAUDE.md` / `.env.example` / existing config), then ask the user
only for what's missing:
- **App name / slug** → names the generated skill (e.g. `acme-notify`).
- **Hub base URL** (e.g. `https://hub.acme.com`). Limits can be discovered at `GET {HUB}/.well-known/a2h`.
- **Auth** — how the agent obtains its Hub **bearer token** (env var name like `A2H_TOKEN`, a secret
  manager, etc.). **Never hardcode the token** in the generated skill.
- **Agent identity** — how to fill `agent.id` / `agent.run_id` / `agent.runtime` / `agent.project` from
  the app's runtime.
- **Defaults** — default `priority` and `tags`, if any.

### 2. Generate the skill
Write `<skills-dir>/<app>-notify/SKILL.md` (use the app's skills location; default `.claude/skills/`),
based on the template below with the gathered config substituted. If the app prefers a reliable HTTP call
over an inline `curl`, also emit a small helper script and have the skill call it.

### 3. Verify
Smoke-test: send one test notify and confirm `202` (and that it appears in the inbox). Use a throwaway
title like `[smoke] <app>-notify`. Surface any non-2xx with the Hub's error body.

### 4. Hand off
Tell the user how their agents trigger it and which env/secrets must be present at runtime.

### 5. (Optional) Package as a plugin for your team
If other people's agents should also send to this Hub, offer to package the generated skill(s) as an
**installable plugin** in this repo. Plugin skills live under the **plugin root** — put each generated skill
at `<plugin-root>/skills/<app>-notify/SKILL.md` (move it there from `.claude/skills/`, or point the plugin's
`skills` path at its location), then add `.claude-plugin/plugin.json` and a root
`.claude-plugin/marketplace.json` listing it (bundle whichever verb skills the app exposes — notify/ask/task).
Teammates run `/plugin marketplace add <this-repo>` → `/plugin install <app>-a2h@<marketplace>` and use
`/<app>-notify`. Validate with `claude plugin validate .`.

## Template — the generated `<app>-notify` skill

````markdown
---
name: <APP> notify
description: Send a fire-and-forget notification to a human via <APP>'s A2H Hub (digest, status, FYI — no response expected). Use when an agent has something a human should see but no decision is needed.
---

# Send an A2H `notify`

Compose and POST an A2H `notify` to <APP>'s Hub. Fire-and-forget — do not wait for a reply.

- **Endpoint:** `POST <HUB_URL>/v1/messages`
- **Auth:** the Hub's advertised scheme (capability `auth_schemes`) — `Authorization: Bearer $<AUTH_ENV>` for `bearer`, or the API-key header for `apikey`; read from the environment, never hardcode

**Envelope** (`type: "notify"`):
- `a2h_version`: `"0.2"`
- `created_at`: ISO-8601 now
- `agent`: `{ "id": "<AGENT_ID>", "run_id": "<RUN_ID>", "runtime": "<RUNTIME>", "project": "<PROJECT>" }`  *(every value is a JSON string — keep the quotes)*
- `title`: short subject (≤ 200 chars)
- `body`: detail in **Markdown** (the Hub treats it as untrusted and sanitizes it)
- `priority` *(optional)*: `low | normal | high | urgent` (default `<DEFAULT_PRIORITY>`)
- `tags` *(optional)*: `string[]`

Expect `202 { id, status: "delivered" }` (a `notify` submit ack is `delivered`, not `open` — there is no
response leg). On non-2xx, surface the error. Do **not** blind-retry — `notify` has no idempotency key, so
a retry creates a duplicate.

> The `Authorization: Bearer` line below is the `bearer`-scheme example — for an `apikey` Hub, swap in its advertised API-key header.

```bash
curl -sS -X POST "<HUB_URL>/v1/messages" \
  -H "Authorization: Bearer $<AUTH_ENV>" \
  -H "Content-Type: application/json" \
  -d '{
    "a2h_version": "0.2",
    "type": "notify",
    "created_at": "'"$(date -u +%FT%TZ)"'",
    "agent": { "id": "<AGENT_ID>", "run_id": "'"$RUN_ID"'", "runtime": "<RUNTIME>", "project": "<PROJECT>" },
    "title": "Daily digest",
    "body": "## What shipped\n- …"
  }'
```
````

## References
- Spec: <https://a2hprotocol.org/spec/v0.2.md> · Message schema: <https://a2hprotocol.org/schema/v0.2/message.schema.json>
- A2H overview: <https://a2hprotocol.org>
