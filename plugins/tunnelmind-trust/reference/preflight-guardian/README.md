# Preflight Guardian

A zero-dependency reference harness that **enforces** the
[`preflight-should-i-act`](../../skills/preflight-should-i-act/SKILL.md) skill in
code.

A skill teaches the model the policy. The Guardian makes the policy
load-bearing for an **unattended** agent: it runs the pre-flight check *before*
the action executes, applies the decision table, and cannot be skipped by
accident.

```js
import { createGuardian, PreflightDenied } from './preflight-guardian.mjs';

const { guard } = createGuardian({ agentId: 'agent.acme.bidder.v1' });

try {
  await guard('api.vendor.com', 'transact', () => payInvoice(invoice));
} catch (e) {
  if (e instanceof PreflightDenied) reportBlocked(e.node, e.reasons, e.receipt);
  else throw e;
}
```

`guard(node, intent, action, opts?)`:

- runs `POST /v1/preflight` for `node`,
- on **allow** → runs `action()` and returns its result,
- on **caution** → runs your `onCaution` handler (human-in-the-loop); proceeds
  only if it returns `true`, otherwise throws `PreflightCaution`,
- on **deny** → throws `PreflightDenied`; `action()` never runs,
- on a **hard floor** (`ghostroute.rpki=INVALID` — possible BGP hijack — or a
  `sanctions_match`) → forces a deny *even if* the numeric decision was allow,
- **persists the `consultation_receipt`** for every check via `onReceipt`,
  whatever the outcome — proof the check ran.

## Why a harness and not just the skill

The skill makes a well-behaved model *choose* to check. The Guardian makes the
check structural: the action is physically behind the gate, the hard floors are
re-enforced client-side, and the receipt is written before the action — so the
provenance trail exists even on the paths where the model would have forgotten.

## Options

| option | default | meaning |
|--------|---------|---------|
| `agentId` | — | stable caller id, recorded in every receipt |
| `thresholds` | server default (`allow ≥ 0.70`, `caution ≥ 0.40`) | `{ allow, caution }` overrides |
| `apiKey` | — | Bearer token for pro/enterprise rate limits |
| `onCaution` | refuse | `async (info) => boolean` — your human-in-the-loop |
| `onReceipt` | append JSONL | `async (record) => void` — where receipts go |
| `clearedTtlMs` | `0` (off) | cache `allow` per node for this long to skip re-checks |
| `fetch` | global `fetch` | inject for tests / non-standard runtimes |
| `baseUrl` | `https://data.tunnelmind.ai` | API base |

Pass `{ ait }` in `opts` to chain the consultation onto an ATAP AIT as a
witness event.

## Run the self-check

```
node example.mjs
```

Exercises allow / caution (refused + approved) / deny / hard-floor override and
receipt persistence with an injected fake `fetch` — no network required.

## Runtime

Any runtime with a global `fetch` (Node ≥ 18, Cloudflare Workers, Deno,
browsers). The default receipt sink uses `node:fs`; pass `onReceipt` to persist
elsewhere off-Node.

---

Apache-2.0. A Claude packaging artifact and distribution surface — not a
protocol. Built on the public TunnelMind API; see
[tunnelmind.ai](https://tunnelmind.ai).
