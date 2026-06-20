# ahcp-skills

**The agent-native toolkit for [AHCP](https://ahcpprotocol.org)** — the Agent Human Coordination
Protocol: a vendor-neutral way for an agent fleet to coordinate with a human (`notify` · `ask` · `task`).

There are two sides to AHCP, and this plugin has a skill for each:

| Skill | Side | What it does |
|---|---|---|
| `/ahcp-skills:implement` | **Hub** (receiver) | Implement a conformant AHCP **Hub** in your app — receive messages, present them to a human, sign + route the response back. **Stack-agnostic** (any language/framework); graded against the conformance vectors, not a copied reference. |
| `/ahcp-skills:build-notify` | sender | Generate an app-specific `<app>-notify` skill — fire-and-forget notifications (digests, status, FYIs). |
| `/ahcp-skills:build-ask` | sender | Generate an app-specific `<app>-ask` skill — ask a human a decision; the signed answer routes back. |
| `/ahcp-skills:build-task` | sender | Generate an app-specific `<app>-task` skill — ask a human to do a manual action, then mark it done. |

The skills are **independent** — use only the ones you need. Building a Hub? Run `implement`. Only need
your agents to fire off notifications to an existing Hub? Just run `build-notify`.

## Install

```
/plugin marketplace add autnmy/ahcp-protocol
/plugin install ahcp-skills@ahcp
```

## Typical flow

1. **`/ahcp-skills:implement`** — stand up your AHCP Hub (the receiver), on your stack. *(Skip if you're
   sending to someone else's Hub.)*
2. **`/ahcp-skills:build-notify`** (and/or `:build-ask` / `:build-task`) — in the apps whose agents should
   *send* to that Hub, generate the app-specific verb skills, wired to its URL + auth.
3. The builders can also **package the generated skills as a plugin** in your repo, so your whole team
   installs them and points their agents at your Hub.

(They also auto-trigger from intent, e.g. "implement AHCP in my app" or "add AHCP notify".)

## License

Apache-2.0 · part of [autnmy/ahcp-protocol](https://github.com/autnmy/ahcp-protocol).
