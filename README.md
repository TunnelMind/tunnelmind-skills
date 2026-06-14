# TunnelMind Skills

Trust-attestation [skills](https://code.claude.com/docs/en/plugins) for Claude
agents operating on the open web. Built **claude-first** on the TunnelMind
verify/preflight API.

An agent that loads these skills knows to ask *"should I act on this
destination?"* and *"who is this, really?"* **before** it transacts — and keeps
a signed, independently re-checkable receipt of every check it made.

This is the procedural layer on top of TunnelMind's live data plane (REST at
`data.tunnelmind.ai` + MCP at `mcp-data.tunnelmind.ai`). The skills drive those
tools; they don't replace them.

## Install

```
/plugin marketplace add TunnelMind/tunnelmind-skills
/plugin install tunnelmind-trust@tunnelmind
```

Plugin skills are namespaced by the plugin, e.g.
`/tunnelmind-trust:preflight-should-i-act`.

The skills call the public TunnelMind API. The free tier needs no key; for
higher limits pass `Authorization: Bearer <key>` (see
[tunnelmind.ai](https://tunnelmind.ai)).

## Skills

| Skill | Question it answers | Returns |
|-------|--------------------|---------|
| `preflight-should-i-act` | May I act on this destination **right now**? | `allow` / `caution` / `deny` + a 5-minute signed consultation receipt |
| `verify-actor` | **Who** is this and do its claims hold? | Fused Scry × Sigil × GhostRoute verdict + adversary classification + a durable signed receipt |

Use **pre-flight** as an action gate before a payment, credential send, fetch,
or publish. Use **verify** for due diligence, attribution, and durable
attestation.

## How these are maintained

The `SKILL.md` files are **generated** from the TunnelMind OpenAPI spec
(`openapi.yaml` in the `tunnelmind-data-api` repo) by `skills/generate.js`, so
the request/response contract in each skill can't drift from the live API. Do
not hand-edit the generated `SKILL.md` files — change the generator template or
the spec and re-publish:

```
# from the tunnelmind-data-api repo
npm run skills:publish      # regenerates skills into this repo
```

The authored decision logic (when to call, how to act on each verdict, receipt
retention) lives in the generator templates; the contract facts are pulled from
the spec.

## License

[Apache-2.0](./LICENSE). These skills are a Claude packaging artifact and a
distribution surface — not a protocol. The open, vendor-neutral standards
(ATAP, OAI, checks) live in their own repos.
