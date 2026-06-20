# Migration — A2H → AHCP

The protocol formerly presented as **A2H — Agent-to-Human Protocol** is now named
**AHCP — Agent Human Coordination Protocol**. There are **two** changes to be aware of:

1. **The name** — `A2H` → `AHCP`. A pure naming/documentation change; nothing on the wire changed.
2. **The domain** — `a2hprotocol.org` → `ahcpprotocol.org`. This moves the website **and** the schema
   `$id` identifier URLs. It is a deliberate **pre-1.0 breaking change** to the schema identifiers,
   softened by a redirect (below). The message format itself is unchanged.

If you have already integrated against A2H, your **wire format is unchanged** — same envelope, same
`a2h_version`, same signature scheme. The only thing that may affect you is the schema `$id` domain
(change 2), and only if you fetch schemas by their `$id` URL.

## 1. The name (non-breaking)

| Before | After |
|--------|-------|
| **A2H** | **AHCP** |
| **Agent-to-Human Protocol** | **Agent Human Coordination Protocol** |

Everywhere the protocol was *described* — titles, headings, prose, badges, metadata, descriptions — the
name is now AHCP. No code change is required for this.

## 2. The domain (pre-1.0 breaking)

The website and the schema identifier namespace moved from `a2hprotocol.org` to `ahcpprotocol.org`:

- **Website** — `https://ahcpprotocol.org` is the live site (CNAME, canonical, OpenGraph, sitemap).
- **Schema `$id`s** — every JSON Schema's `"$id"` is now `https://ahcpprotocol.org/schema/vX.Y/...`
  (e.g. `https://ahcpprotocol.org/schema/v0.3/message.schema.json`), and the reference resolver `BASE`
  matches. `CONTRIBUTING.md` treats a `$id` change as breaking; this was done deliberately while the spec
  is **pre-1.0 Draft** (GOVERNANCE permits breaking changes before 1.0) so the identity is clean before
  1.0 locks it.

**What this means for you:**

- The **wire format is unchanged** — `a2h_version`, the `A2H-Signature` header, `A2H_CALLBACK_SECRET`,
  `/.well-known/a2h`, `x-a2h-sensitive`, the message/response shapes, and the signature algorithm are all
  identical. An implementation that validates against a **bundled local copy** of the schema needs no
  change.
- If your implementation **fetches schemas by their `$id` URL** at `a2hprotocol.org`, update the host to
  `ahcpprotocol.org` (or rely on the redirect below).
- **`a2hprotocol.org` 301-redirects to `ahcpprotocol.org`**, so old pinned schema/spec URLs continue to
  resolve during the transition.

## What did NOT change (still frozen)

These on-the-wire and distribution identifiers retain the `a2h` slug and are unchanged by either change
above. The lowercase `a2h` remains the protocol's stable wire/distribution slug; **AHCP** is its brand.

### Wire identifiers — never rename

| Identifier | Where | Why it is frozen |
|------------|-------|------------------|
| `a2h_version` | every message envelope | Renaming it breaks all parsers and every example/conformance vector. |
| `A2H-Signature` | HTTP response header (spec §9.2) | Part of the detached-signature scheme; renaming breaks callback verification across implementations. |
| `A2H_CALLBACK_SECRET` | env var convention (spec §8.3) | Referenced by `secret_ref` examples and conformance vectors. |
| `GET /.well-known/a2h` | discovery endpoint (spec §8.0) | A wire endpoint path; renaming it breaks discovery. |
| `x-a2h-sensitive` | JSON-Schema extension field | Marks fields kept out of the agent's LLM context; renaming breaks schema validation and the sensitive-field example. |

### Distribution names — never rename (live, in use)

| Name | Why it is frozen |
|------|------------------|
| `@a2h/reference` (npm package) | Existing installs and import paths depend on it. |
| `a2h` (reference CLI binary) | Scripts and docs invoke it by name; the website terminal demo mirrors it verbatim. |
| `a2h-skills` (plugin), `@a2h` (marketplace), `/plugin install a2h-skills@a2h`, `plugins/a2h-skills/` (path) | Existing plugin installs and namespacing depend on these exact strings. |
| `autnmy/a2h-protocol`, `https://github.com/autnmy/a2h-protocol/…` | The GitHub repository slug and every link to it; a docs change cannot rename the repo, and stale links would 404. |

## Disambiguation: the phrase "agent-to-human"

"AHCP" replaces "A2H" and "Agent-to-Human Protocol" **as the proper-noun name of the protocol**. The
phrase "agent-to-human" or "agent ↔ human" used as a *plain-English description of direction* — e.g.
"AHCP standardizes how agents coordinate with humans" — is descriptive and stays. Only the protocol's
*name* changes.

## For implementers

- **Name:** nothing to do — your existing A2H integration is conformant AHCP.
- **Domain:** if you fetch schemas by `$id` URL, repoint from `a2hprotocol.org` to `ahcpprotocol.org`
  (or rely on the 301 redirect). The wire format and `a2h_version` are unchanged — no message change.
- Do **not** rename `a2h_version`, the `A2H-Signature` header, `A2H_CALLBACK_SECRET`, the
  `/.well-known/a2h` path, or `x-a2h-sensitive` — those are the interoperability contract and are
  unchanged.
