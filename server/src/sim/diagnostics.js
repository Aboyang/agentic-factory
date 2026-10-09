// "System 1" diagnosis (docs/SIM_SPEC.md section 5): a fast, deliberately naive
// prior computed only from what the plant shows — signal readings, trends and
// active fault codes from sim.telemetryContext. It never reads hidden health.
// It trusts fault codes, so in the Brownout preset it blames the servo first;
// the orchestrator recovers by re-diagnosing with that part ruled out.

import { sim, formatReading, formatThreshold, formatChange, warnCode } from './engine.js';

const TEMPERATURE = 0.25;
const SIGNIFICANT_TREND = 0.04; // a 10-min change ≥ 4% of the nominal→fail span is a real trend, not noise
const MAX_EVIDENCE = 4;

/**
 * @returns {{ probabilities: Record<string, number>,
 *             ranking: { componentId, name, status, score, probability, evidence: string[] }[],
 *             evidence: string[] }}
 */
export function scoreComponents(machineId, options = {}) {
  const empty = { probabilities: {}, ranking: [], evidence: [] };
  const ctx = sim.telemetryContext(machineId);
  if (!ctx) return empty;

  const ruledOut = new Set((Array.isArray(options?.ruledOut) ? options.ruledOut : []).map(String));
  const candidates = ctx.parts.filter((p) => !ruledOut.has(p.id) && !ruledOut.has(p.name));
  if (!candidates.length) return empty;

  const scored = candidates.map((part, order) => {
    const maxSeverity = Math.max(0, ...part.signals.map((s) => s.severity || 0));
    const faulted = ctx.activeCodes.includes(part.code);
    return { part, order, maxSeverity, faulted, score: 0.6 * maxSeverity + 0.4 * (faulted ? 1 : 0) };
  });

  // softmax(score / T); subtract the max first for numerical stability
  const top = Math.max(...scored.map((s) => s.score));
  const weights = scored.map((s) => Math.exp((s.score - top) / TEMPERATURE));
  const total = weights.reduce((a, b) => a + b, 0);
  scored.forEach((s, i) => (s.probability = weights[i] / total));

  scored.sort((a, b) => b.score - a.score || b.maxSeverity - a.maxSeverity || a.order - b.order);

  const probabilities = {};
  for (const s of scored) probabilities[s.part.name] = round(s.probability, 4);
  // keep the rounded probabilities summing to exactly 1
  const drift = 1 - Object.values(probabilities).reduce((a, b) => a + b, 0);
  probabilities[scored[0].part.name] = round(probabilities[scored[0].part.name] + drift, 4);

  const ranking = scored.map((s) => ({
    componentId: s.part.id,
    name: s.part.name,
    status: s.part.status,
    score: round(s.score, 3),
    probability: probabilities[s.part.name],
    evidence: partEvidence(s.part, s.faulted),
  }));

  return { probabilities, ranking, evidence: ranking[0].evidence.slice(0, MAX_EVIDENCE) };
}

/** Most important first: the fault/warn code, then abnormal signals by severity, then normal ones. */
function partEvidence(part, faulted) {
  const lines = [];
  if (faulted) lines.push(`FAULT ${part.code} ${part.fault}`);
  else if (part.status === 'warn') lines.push(`WARN ${warnCode(part.code)} active ${fmtMinutes(part.warnForMinutes)}`);

  const signals = [...part.signals].sort((a, b) => (b.severity || 0) - (a.severity || 0));
  const abnormal = signals.filter((s) => s.status !== 'ok' || trendToward(s));
  for (const s of abnormal) lines.push(signalLine(s));
  for (const s of signals) if (!abnormal.includes(s)) lines.push(`${label(s)} normal`);
  return lines.slice(0, MAX_EVIDENCE);
}

function signalLine(s) {
  let line = label(s);
  if (s.status === 'fault') line += ` (limit ${formatThreshold(s, s.fail)})`;
  else line += ` (warn ${formatThreshold(s, s.warn)})`;
  const trend = trendText(s);
  return trend ? `${line}, ${trend}` : line;
}

const label = (s) => `${s.label} ${formatReading(s, s.value)}`;

function isSignificant(s) {
  const span = Math.abs(s.fail - s.nominal);
  return s.trendMinutes > 0 && span > 0 && Math.abs(s.trend10m) >= SIGNIFICANT_TREND * span;
}

/** A significant trend that moves the reading toward its fail value. */
function trendToward(s) {
  return isSignificant(s) && Math.sign(s.trend10m) === Math.sign(s.fail - s.nominal);
}

function trendText(s) {
  if (!isSignificant(s)) return '';
  return `${s.trend10m < 0 ? 'falling' : 'rising'} ${formatChange(s, s.trend10m)} in ${fmtMinutes(s.trendMinutes)}`;
}

const fmtMinutes = (m) => `${Math.round(m)} min`;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
