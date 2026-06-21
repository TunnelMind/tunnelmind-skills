/**
 * preflight-guardian.mjs — TunnelMind Preflight Guardian
 *
 * A zero-dependency reference harness that ENFORCES the `preflight-should-i-act`
 * skill in code. A skill teaches the model the policy; the Guardian makes the
 * policy load-bearing for an unattended agent:
 *
 *   - runs POST /v1/preflight before a consequential action executes,
 *   - applies the allow / caution / deny decision table,
 *   - honors the hard floors (RPKI-INVALID origin, sanctions match) even if the
 *     numeric decision did not already deny,
 *   - persists every `consultation_receipt` to an action log — proof the check
 *     ran, whatever the outcome,
 *   - optionally chains an ATAP `ait` so the consultation is a witness event.
 *
 * Pairs with the `preflight-should-i-act` SKILL in this plugin. Contract:
 * https://data.tunnelmind.ai/v1/preflight  ·  https://tunnelmind.ai
 *
 * Runtime: any with global `fetch` (Node >= 18, Cloudflare Workers, Deno,
 * browsers). The default action-log sink uses `node:fs`; pass `onReceipt` to
 * persist elsewhere in non-Node runtimes.
 */

const DEFAULT_BASE = 'https://data.tunnelmind.ai';

/** Base class — carries the decision, reasons, and the receipt of the check. */
export class PreflightError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'PreflightError';
    this.node = info.node;
    this.intent = info.intent;
    this.decision = info.decision;
    this.reasons = info.reasons;
    this.receipt = info.receipt;       // consultation_receipt — keep it as proof
    this.result = info.result;         // full /v1/preflight data
  }
}

/** decision === 'deny', or a hard floor tripped. The action must not run. */
export class PreflightDenied extends PreflightError {
  constructor(info) {
    super(`preflight DENIED for "${info.node}": ${(info.reasons ?? []).join('; ')}`, info);
    this.name = 'PreflightDenied';
  }
}

/** decision === 'caution' and no `onCaution` handler approved proceeding. */
export class PreflightCaution extends PreflightError {
  constructor(info) {
    super(`preflight CAUTION for "${info.node}" — human-in-the-loop required: ${(info.reasons ?? []).join('; ')}`, info);
    this.name = 'PreflightCaution';
  }
}

function pruneUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * A hard floor overrides the headline score. The server already folds these
 * into the decision, but we re-check defensively so a future scoring change can
 * never let a hijacked or sanctioned route through as anything but a deny.
 */
function hardFloorTripped(data) {
  const g = data.ghostroute;
  if (g && g.available && (g.rpki_status === 'INVALID' || g.sanctions_match === true)) return true;
  return (data.reasons ?? []).some(r => /ghostroute\.rpki=INVALID|sanctions_match/.test(String(r)));
}

/** Default action-log sink: append one JSON line per check to a file (Node). */
async function defaultReceiptSink(record) {
  const path = globalThis.process?.env?.TUNNELMIND_ACTION_LOG ?? 'tunnelmind-action-log.jsonl';
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, JSON.stringify(record) + '\n');
}

/**
 * Create a Guardian bound to an agent identity + policy.
 *
 * @param {object} options
 * @param {string} [options.baseUrl]      TunnelMind data API base. Default prod.
 * @param {string} [options.agentId]      Stable caller id, recorded in every receipt.
 * @param {object} [options.thresholds]   { allow, caution } overrides (0 <= caution < allow <= 1).
 * @param {string} [options.apiKey]       Bearer token for pro/enterprise limits.
 * @param {Function} [options.fetch]      fetch implementation (default: global fetch).
 * @param {Function} [options.onReceipt]  async (record) => void — persist the receipt. Default: JSONL file.
 * @param {Function} [options.onCaution]  async (info) => boolean — return true to proceed on `caution`. Default: refuse.
 * @param {number} [options.clearedTtlMs] If > 0, cache `allow` per node for this long to skip re-checks in a session.
 */
export function createGuardian(options = {}) {
  const {
    baseUrl = DEFAULT_BASE,
    agentId,
    thresholds,
    apiKey,
    fetch: fetchImpl = globalThis.fetch,
    onReceipt = defaultReceiptSink,
    onCaution = null,
    clearedTtlMs = 0,
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new Error('Preflight Guardian: no global fetch — pass options.fetch');
  }

  const cleared = new Map(); // node -> expiry epoch ms

  /** Raw consultation: returns the /v1/preflight `data` object, no enforcement. */
  async function preflight(node, intent, { ait, signal } = {}) {
    if (!node) throw new Error('preflight: node is required');
    const res = await fetchImpl(`${baseUrl}/v1/preflight`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(pruneUndefined({ node, intent, agent_id: agentId, thresholds, ait })),
      signal,
    });
    let json;
    try { json = await res.json(); }
    catch { throw new Error(`preflight: non-JSON response (HTTP ${res.status})`); }
    if (!res.ok || json.ok === false) {
      throw new Error(`preflight: ${json.error ?? `HTTP ${res.status}`}`);
    }
    return json.data ?? json;
  }

  /**
   * Gate `action` behind a pre-flight check.
   * Resolves to action()'s result on allow (or human-approved caution).
   * Throws PreflightDenied / PreflightCaution otherwise — action never runs.
   *
   * @param {string}   node    destination (ip | domain | asn | entity_slug)
   * @param {string}   intent  free-form context, e.g. "transact" | "credential"
   * @param {Function} action  async () => T — the consequential operation
   * @param {object}   [opts]  { ait, signal }
   */
  async function guard(node, intent, action, opts = {}) {
    if (clearedTtlMs > 0) {
      const exp = cleared.get(node);
      if (exp && exp > Date.now()) return action();
    }

    const data = await preflight(node, intent, opts);
    const receipt = data.consultation_receipt;

    // Persist the receipt regardless of decision — the point is provability.
    await onReceipt({
      at: new Date().toISOString(),
      node, intent,
      agent_id: agentId,
      decision: data.decision,
      reasons: data.reasons,
      consultation_receipt: receipt,
      ...(data.witnessed_event ? { witnessed_event: data.witnessed_event } : {}),
    });

    const info = {
      node, intent,
      decision: data.decision,
      reasons: data.reasons,
      receipt,
      result: data,
    };

    if (hardFloorTripped(data) || data.decision === 'deny') {
      throw new PreflightDenied(info);
    }

    if (data.decision === 'caution') {
      const proceed = onCaution ? await onCaution(info) : false;
      if (!proceed) throw new PreflightCaution(info);
    }

    if (clearedTtlMs > 0) cleared.set(node, Date.now() + clearedTtlMs);
    return action();
  }

  return { guard, preflight };
}

export default createGuardian;
