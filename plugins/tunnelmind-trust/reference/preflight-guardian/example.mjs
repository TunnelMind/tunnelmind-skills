/**
 * example.mjs — runnable demo + self-check for the Preflight Guardian.
 *
 *   node example.mjs
 *
 * It injects a fake `fetch` so it runs offline and exercises every branch:
 * allow, caution (refused + approved), deny, and a hard-floor (RPKI-INVALID)
 * that the server scored as `allow` but the Guardian must still deny. Receipts
 * are collected in memory instead of written to disk.
 *
 * Real usage (no fake fetch) is at the bottom.
 */

import { createGuardian, PreflightDenied, PreflightCaution } from './preflight-guardian.mjs';

// ── A fake /v1/preflight keyed on the node, in the real response envelope ────
const RESPONSES = {
  'good.example':   { decision: 'allow',   reasons: ['adjusted_trust=0.910'] },
  'sketchy.example':{ decision: 'caution', reasons: ['decision: trust signal in the warn band'] },
  'evil.example':   { decision: 'deny',    reasons: ['decision: trust signal below caution threshold'] },
  // Server returned allow, but the routing floor must override it to a deny:
  'hijacked.example': {
    decision: 'allow',
    reasons: ['ghostroute.rpki=INVALID — origin announces an RPKI-invalid prefix (possible BGP hijack)'],
    ghostroute: { available: true, rpki_status: 'INVALID' },
  },
};

const fakeFetch = async (_url, init) => {
  const { node } = JSON.parse(init.body);
  const base = RESPONSES[node] ?? { decision: 'deny', reasons: ['unknown node'] };
  const data = {
    node,
    cross_lens: {}, tracker: {}, scry: {}, sigil: {}, ghostroute: null,
    consultation_receipt: { sigil_token: `tok_${node}`, issued_by: 'OAI-TEST', expires_at: '2099-01-01T00:00:00Z' },
    ...base,
  };
  return { ok: true, json: async () => ({ ok: true, data, meta: { took_ms: 1 } }) };
};

// ── Wire up a Guardian with in-memory receipts + a caution policy ────────────
const receipts = [];
let approveCaution = false;

const { guard } = createGuardian({
  agentId: 'agent.demo.v1',
  fetch: fakeFetch,
  onReceipt: async (r) => { receipts.push(r); },
  onCaution: async (info) => approveCaution, // human-in-the-loop stand-in
});

const runAction = () => 'ACTION RAN';
let pass = 0, fail = 0;
const check = (label, cond) => { (cond ? pass++ : fail++); console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`); };

// allow → action runs
check('allow runs the action', (await guard('good.example', 'fetch', runAction)) === 'ACTION RAN');

// deny → throws, action never runs
try { await guard('evil.example', 'transact', runAction); check('deny throws', false); }
catch (e) { check('deny throws PreflightDenied', e instanceof PreflightDenied); }

// caution, refused → throws
approveCaution = false;
try { await guard('sketchy.example', 'credential', runAction); check('caution(refused) throws', false); }
catch (e) { check('caution(refused) throws PreflightCaution', e instanceof PreflightCaution); }

// caution, approved → action runs
approveCaution = true;
check('caution(approved) runs the action', (await guard('sketchy.example', 'credential', runAction)) === 'ACTION RAN');

// hard floor → deny even though the server said allow
try { await guard('hijacked.example', 'transact', runAction); check('hard floor overrides allow', false); }
catch (e) { check('hard floor (RPKI-INVALID) forces deny', e instanceof PreflightDenied); }

// every check, whatever the outcome, left a receipt behind
check('a receipt was kept for every check', receipts.length === 5 && receipts.every(r => r.consultation_receipt?.sigil_token));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

/* ── Real usage ────────────────────────────────────────────────────────────
import { createGuardian, PreflightDenied } from './preflight-guardian.mjs';

const { guard } = createGuardian({
  agentId: 'agent.acme.bidder.v1',
  // apiKey: process.env.TUNNELMIND_API_KEY,        // optional, for higher limits
  onCaution: async ({ node, reasons }) => askHuman(`Proceed with ${node}? ${reasons.join('; ')}`),
});

try {
  const res = await guard('api.vendor.com', 'transact', () => payInvoice(invoice), {
    ait: 'AIT-0192f5d3-2c1e-7af6-bd84-9c4a3e8b7d12',   // optional ATAP witness chain
  });
} catch (e) {
  if (e instanceof PreflightDenied) reportBlocked(e.node, e.reasons, e.receipt);
  else throw e;
}
──────────────────────────────────────────────────────────────────────────── */
