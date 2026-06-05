# a2h-skills

**The agent-native toolkit for the [A2H protocol](https://a2hprotocol.org)** — Agent-to-Human:
a vendor-neutral way for an agent to reach a human and get a decision back (`notify` · `ask` · `task`).

There are two sides to A2H, and this plugin has a skill for each:

| Skill | Side | What it does |
|---|---|---|
| `/a2h-skills:implement` | **Hub** (receiver) | Implement a conformant A2H **Hub** in your app — receive messages, present them to a human, sign + route the response back. **Stack-agnostic** (any language/framework); graded against the conformance vectors, not a copied reference. |
| `/a2h-skills:build-notify` | sender | Generate an app-specific `<app>-notify` skill — fire-and-forget notifications (digests, status, FYIs). |
| `/a2h-skills:build-ask` | sender | Generate an app-specific `<app>-ask` skill — ask a human a decision; the signed answer routes back. |
| `/a2h-skills:build-task` | sender | Generate an app-specific `<app>-task` skill — ask a human to do a manual action, then mark it done. |

The skills are **independent** — use only the ones you need. Building a Hub? Run `implement`. Only need
your agents to fire off notifications to an existing Hub? Just run `build-notify`.

## Install

```
/plugin marketplace add autnmy/a2h-protocol
/plugin install a2h-skills@a2h
```

## Typical flow

1. **`/a2h-skills:implement`** — stand up your A2H Hub (the receiver), on your stack. *(Skip if you're
   sending to someone else's Hub.)*
2. **`/a2h-skills:build-notify`** (and/or `:build-ask` / `:build-task`) — in the apps whose agents should
   *send* to that Hub, generate the app-specific verb skills, wired to its URL + auth.
3. The builders can also **package the generated skills as a plugin** in your repo, so your whole team
   installs them and points their agents at your Hub.

(They also auto-trigger from intent, e.g. "implement A2H in my app" or "add A2H notify".)

## License

Apache-2.0 · part of [autnmy/a2h-protocol](https://github.com/autnmy/a2h-protocol).
