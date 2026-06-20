# Migration — A2H → AHCP

The protocol formerly presented as **A2H — Agent-to-Human Protocol** is now named
**AHCP — Agent Human Coordination Protocol**.

This is a **naming and documentation change only.** Nothing on the wire changed. The version did not
change. Schemas, endpoints, the signature scheme, the message envelope, the npm package, the CLI, and
the plugin are all unchanged. **No conformant implementation needs to change a single line of code to
remain conformant.** If you have already integrated against A2H, you are already integrated against
AHCP.

## What changed

| Before | After |
|--------|-------|
| **A2H** | **AHCP** |
| **Agent-to-Human Protocol** | **Agent Human Coordination Protocol** |

That's it. The name. Everywhere the protocol was *described* — titles, headings, prose, badges,
metadata, descriptions — the name is now AHCP.

## What did NOT change (frozen surface)

The protocol's on-the-wire identifiers and its published distribution names are **frozen**. They retain
the `a2h` / `A2H` token because changing them would break every existing message, signature, schema
reference, and install — i.e. it would be a breaking change requiring a version bump, which this rename
explicitly is not. The lowercase `a2h` is the protocol's stable wire/distribution slug; **AHCP** is its
brand.

### Wire identifiers — never rename

| Identifier | Where | Why it is frozen |
|------------|-------|------------------|
| `a2h_version` | every message envelope | Renaming it breaks all parsers and every example/conformance vector. |
| `A2H-Signature` | HTTP response header (spec §9.2) | Part of the detached-signature scheme; renaming it breaks callback verification across implementations. |
| `A2H_CALLBACK_SECRET` | env var convention (spec §8.3) | Referenced by `secret_ref` examples and conformance vectors. |
| `GET /.well-known/a2h` | discovery endpoint (spec §8.0) | A wire endpoint path; renaming it breaks discovery. |
| `x-a2h-sensitive` | JSON-Schema extension field | Marks fields that must be kept out of the agent's LLM context; renaming it breaks schema validation and the sensitive-field example. |
| `$id` URLs at `https://a2hprotocol.org/schema/...` | every JSON Schema | A non-breaking change keeps the existing `$id` (see `CONTRIBUTING.md`). Changing the domain re-keys every schema and breaks every `$ref`. |

### Distribution names — never rename (live, in use)

| Name | Why it is frozen |
|------|------------------|
| `@a2h/reference` (npm package) | Existing installs and import paths depend on it. |
| `a2h` (reference CLI binary) | Scripts and docs invoke it by name; the website terminal demo mirrors it verbatim. |
| `a2h-skills` (plugin), `@a2h` (marketplace), `/plugin install a2h-skills@a2h`, `plugins/a2h-skills/` (path) | Existing plugin installs and namespacing depend on these exact strings. |
| `autnmy/a2h-protocol`, `https://github.com/autnmy/a2h-protocol/…` | The repository slug and every link to it; a documentation change cannot rename the repo, and stale links would 404. |
| `https://a2hprotocol.org` (canonical site URL) | The live domain; renaming it would break inbound links and the schema `$id`s above. |

> A future, separately-versioned release may rename the wire/distribution slug to match the AHCP brand.
> That is intentionally **out of scope** for this rename, because it is a breaking change for everyone
> who has already adopted the protocol. Until then, treat **AHCP** as the name and **`a2h`** as the
> frozen slug — exactly as many shipped protocols carry a brand distinct from their wire constant.

## Disambiguation: the phrase "agent-to-human"

"AHCP" replaces "A2H" and "Agent-to-Human Protocol" **as the proper-noun name of the protocol**. The
phrase "agent-to-human" or "agent ↔ human" used as a *plain-English description of direction* — e.g.
"AHCP standardizes how agents coordinate with humans," or the family line "the agent↔human complement
to A2A" — is descriptive and stays. Only the protocol's *name* changes.

## For implementers

- **Nothing to do.** Your existing A2H integration is conformant AHCP.
- Update any *prose* in your own docs/UI that names the protocol "A2H" to "AHCP" at your convenience.
- Do **not** rename `a2h_version`, the `A2H-Signature` header, `A2H_CALLBACK_SECRET`, the
  `/.well-known/a2h` path, `x-a2h-sensitive`, or your schema `$ref`s — those are the interoperability
  contract and are unchanged.
