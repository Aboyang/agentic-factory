// HARD spending limits. Plain code, never a model. The model only recommends;
// this decides whether the agent may pay alone, must ask, or is blocked.
//
// Note: Reap mandates (pre-approved terms) are "not available yet" per the docs,
// so our own policy decides AUTO vs ESCALATE. In the sandbox, AUTO uses the
// X-Simulate-Checkout header; ESCALATE sends the manager to Reap's approval page.

export const DEFAULT_POLICY = Object.freeze({
  autoApproveLimit: 60, // USD per order the agent may spend alone
  monthlyBudget: 1000, // USD
  spent: 0, // USD this month (updated after each completed checkout)
  confidenceThreshold: 0.75, // below this the agent always asks
  allowedMerchants: Object.freeze(['Switch Electronics', 'Digitmakers.ca', 'Tech For Less']),
  expressForCriticalOnly: true,
  predictiveMaintenance: false, // replace parts that WARN before they FAULT
});

const EDITABLE = ['autoApproveLimit', 'monthlyBudget', 'confidenceThreshold', 'allowedMerchants', 'expressForCriticalOnly', 'predictiveMaintenance'];

let policy = fresh();

function fresh() {
  return { ...DEFAULT_POLICY, allowedMerchants: [...DEFAULT_POLICY.allowedMerchants] };
}

export function getPolicy() {
  return { ...policy, allowedMerchants: [...policy.allowedMerchants], remaining: round(Math.max(0, policy.monthlyBudget - policy.spent)) };
}

/** Manager's Desk edits. Unknown keys and invalid values are ignored. */
export function updatePolicy(patch = {}) {
  apply(patch, EDITABLE);
  return getPolicy();
}

/** Back to defaults, then a preset's overrides (including `spent`). */
export function reset(overrides = {}) {
  policy = fresh();
  apply(overrides || {}, [...EDITABLE, 'spent']);
  return getPolicy();
}

export function recordSpend(amount) {
  if (Number.isFinite(amount) && amount > 0) policy.spent = round(policy.spent + amount);
}

function apply(patch, keys) {
  if (!patch || typeof patch !== 'object') return;
  for (const k of keys) {
    if (!(k in patch)) continue;
    const v = clean(k, patch[k]);
    if (v !== undefined) policy[k] = v;
  }
}

function clean(key, value) {
  switch (key) {
    case 'autoApproveLimit':
    case 'monthlyBudget':
    case 'spent': {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    }
    case 'confidenceThreshold': {
      const n = Number(value);
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;
    }
    case 'expressForCriticalOnly':
    case 'predictiveMaintenance':
      return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : undefined;
    case 'allowedMerchants':
      if (!Array.isArray(value)) return undefined;
      return [...new Set(value.filter((m) => typeof m === 'string').map((m) => m.trim()).filter(Boolean))];
    default:
      return undefined;
  }
}

/**
 * @returns {{ action: 'AUTO'|'ESCALATE'|'BLOCK', reasons: string[] }}
 */
export function evaluate({ total, merchant, confidence }) {
  const reasons = [];
  const remaining = policy.monthlyBudget - policy.spent;

  if (!policy.allowedMerchants.includes(merchant)) {
    return { action: 'BLOCK', reasons: [`${merchant} is not an approved store`] };
  }
  if (total > remaining) reasons.push(`Over remaining budget ($${total.toFixed(2)} > $${Math.max(0, remaining).toFixed(2)})`);
  if (total > policy.autoApproveLimit) reasons.push(`Over auto-approve limit ($${total.toFixed(2)} > $${policy.autoApproveLimit})`);
  if (confidence < policy.confidenceThreshold)
    reasons.push(`Not sure enough (${Math.round(confidence * 100)}% < ${Math.round(policy.confidenceThreshold * 100)}%)`);

  if (reasons.length) return { action: 'ESCALATE', reasons };
  return { action: 'AUTO', reasons: [`Within limits: $${total.toFixed(2)} ≤ $${policy.autoApproveLimit}, ${Math.round(confidence * 100)}% sure`] };
}

const round = (n) => Math.round(n * 100) / 100;
