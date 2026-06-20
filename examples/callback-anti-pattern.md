# Callback anti-pattern: the confused deputy

**Do not do this.** AHCP v0.1's worked example pointed an `ask` callback straight at a third-party API
holding the agent's credential:

```jsonc
// ANTI-PATTERN — rejected by a conformant Hub
"callback": {
  "mode": "push",
  "url": "https://api.github.com/repos/tmlayton/web-app/dispatches",
  "auth": { "scheme": "bearer", "token_ref": "env:A2H_GH_DISPATCH_TOKEN" }
}
```

Why it's dangerous (SSRF / confused deputy):

- The Hub becomes a credentialed HTTP client POSTing to an **arbitrary agent-supplied URL** with a live
  GitHub PAT. Point `url` at an internal/metadata endpoint and the Hub fetches it and may leak the token.
- A human clicking "ship" is laundered into a privileged third-party write (`repository_dispatch`) — the
  decision triggers a side effect the human never saw.
- v1's mandated callback retries turn the Hub into a reflector hammering the target.

## The safe pattern

Point the callback at an **agent-owned re-invoke endpoint** whose host is pre-registered and
ownership-verified for your `agent.id` (spec §9.4). The endpoint receives the **signed** Response (§9.2),
verifies the signature, then *the agent itself* (not the Hub) takes any privileged downstream action
using its own credentials:

```jsonc
"callback": {
  "mode": "push",
  "url": "https://deploybot.example/a2h/resume",          // agent-owned, registered, verified
  "auth": { "scheme": "hmac", "secret_ref": "env:A2H_CALLBACK_SECRET" }
}
```

A conformant v2 Hub MUST refuse to attach a credential to an unverified host, MUST refuse private/
link-local/metadata ranges **at delivery time** (DNS-rebinding defense), and MUST NOT follow redirects.
See `examples/callback-agent-resume.json` for the full safe message.
