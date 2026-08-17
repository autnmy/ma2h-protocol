# Worked example — the durable operator stop (§16.4.1)

This walks the **hard stop** end to end and, more usefully, shows the two ways the *cooperative*
kill-switch (§16.4) fails while every party behaves correctly. Those two failures are the whole
motivation; the normative rules exist to close them and nothing else.

One story throughout: the account's human operator stops runaway agent `deploybot/dev-team`, whose
supervisor restarts it on crash and whose platform redeploys it on every push.

## 0. Detecting which Hub you are talking to

```http
GET /.well-known/ma2h
```

```json
{
  "ma2h_version": "0.5",
  "sessions": {
    "enabled": true,
    "max_ttl_seconds": 3600,
    "max_live_per_agent": 16,
    "terminal_retention_seconds": 3600,
    "operator_hard_stop": true
  }
}
```

`operator_hard_stop: true` is the only way a client can know a stop will hold. **Absent or `false`
means cooperative** — see §3 for what that costs. A client MUST NOT infer the hard stop from silence.

## 1. The operator closes the session

The account's authenticated human closes `sess_01J5WRK0007`. The session resource carries the §16.4
marker:

```json
{
  "id": "sess_01J5WRK0007",
  "agent_id": "deploybot/dev-team",
  "state": "closed",
  "closed_by_operator": true,
  "closed_at": "2026-08-16T10:00:00Z"
}
```

The killed party's own-session touchpoints now answer:

```json
{ "error": { "code": "session_closed_by_operator", "message": "stopped by the account operator" } }
```
`HTTP/1.1 410 Gone`

So far this is unchanged from §16.4. A well-behaved client stops here.

## 2. Where the cooperative marker fails

### 2a. The marker dies with the row

At `terminal_retention_seconds` (3600s above) the terminal session is purged. The next touchpoint:

```json
{ "error": { "code": "not_found" } }
```
`HTTP/1.1 404 Not Found`

That response is **byte-identical** to an ordinary lapsed-then-purged session — and §16.3 *requires*
a client to self-heal from that by registering fresh. A kill that no client leg observed inside the
window has silently become a heal. No client-side fix exists: the two cases are indistinguishable on
the wire, by construction.

### 2b. Nothing gates re-registration

Even inside the window, the stop only binds a client that is running and paying attention. A crash
restart, a container redeploy, or an autoscale event calls:

```http
POST /v1/sessions
Authorization: Bearer <deploybot/dev-team credential>
```

On a cooperative Hub this succeeds — `201`, fresh session, agent back at work — with **no human
anywhere in the loop**. The credential was never revoked; that is what "cooperative, not credential
revocation" means.

## 3. The hard stop, on a Hub advertising `operator_hard_stop`

### 3a. The stop outlives the session

The Hub records the stop against the **principal** (`deploybot/dev-team`), not the session row, so
the `terminal_retention_seconds` sweep does not touch it. There is no window after which the kill
degrades into a heal.

### 3b. Registration is refused

```http
POST /v1/sessions
Authorization: Bearer <deploybot/dev-team credential>
```

```json
{ "error": { "code": "session_closed_by_operator", "message": "stopped by the account operator" } }
```
`HTTP/1.1 403 Forbidden`

Note the pairing: **`403`, not `410`** — no session resource is gone; the principal is refused. But
the **`code` is the same one §16.4 already defines**, deliberately. A client that learned "stop; do
not re-register; surface to a human" for the 410 needs no new handling for the 403, and a client that
predates the rule surfaces an unmapped code per §8.5 — which also stops it. Neither loops.

The restart, the redeploy, and the autoscale cycle from §2b all now hit this.

### 3c. Only a human lifts it

The account's authenticated human resumes the principal, and registration succeeds again.

There is deliberately **no agent-facing resume** — not on §8's transports, not as a tool or command
binding over them. This is the rule most likely to be "helpfully" relaxed by an implementer adding a
recovery path, so it is normative: a reset an agent can invoke is reachable by exactly the runaway
the operator was stopping, which makes it the kill-switch's own bypass rather than a recovery path.

## 4. What senders see — unchanged

Throughout all of the above, a *sender* addressed to the stopped principal keeps receiving ordinary
§14.2 bounce receipts and **cannot tell a stopped principal from a crashed one**. The §16.4
attribution boundary and the §16.5 oracle stance are unchanged by this section: the stop is visible to
the stopped party and to the account's human, and to nobody else.

## Conformance checklist

A Hub advertising `operator_hard_stop: true` MUST satisfy **all** of:

1. The stop record is keyed on the principal and independent of the terminal session resource.
2. It survives the `terminal_retention_seconds` purge (§2a cannot recur).
3. `POST /v1/sessions` by a stopped principal → `403` + `session_closed_by_operator`.
4. The gate is evaluated on the authenticating read, so a registration racing a kill resolves to one
   or the other — never a session minted after the stop.
5. No agent-invokable resume exists on any surface.
6. Bounce receipts and sender-visible state are unchanged (§4 above).

Partial implementation is non-conformant: each rule closes a path the others leave open. A Hub that
cannot meet all six MUST omit the capability and offer the cooperative marker instead — which is a
legitimate conformance posture, honestly advertised.
