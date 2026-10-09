// One interface for every fast decision the agent makes.
//
//   decide({ kind: 'choice', question, options, context, image? })
//     → { answer, probabilities: {opt: p}, confidence, provider }
//   decide({ kind: 'score', question, levels: ['1','2','3','4','5'], context })
//     → same shape, answer is one of `levels`
//   decide({ kind: 'yesno', question, context, image? })
//     → { answer: true|false, probabilities: {yes, no}, confidence, provider }
//
// context.prior ({ option: p }) is a heuristic starting point (see
// sim/diagnostics.js). The mock returns it as is; a real model reads the
// telemetry and plant log and may override it.
//
// Providers are tried in order. The first that works wins.
//   1. openaiDecisions  — OpenAI Decisions API (gpt-6-luna, public beta).
//   2. jev              — TypeSafe Jev (fallback).                       TODO
//   3. gptStructured    — plain GPT with JSON-schema output.
//   4. mock             — offline, deterministic. Used when MOCK_AI=1.

import { config } from '../config.js';

const providers = [openaiDecisions, jev, gptStructured];
const TIMEOUT_MS = 20_000;

export async function decide(req) {
  const normalized = normalize(req);
  if (config.mockAi) return mock(normalized);
  for (const p of providers) {
    try {
      const out = await p(normalized);
      if (out) return out;
    } catch (err) {
      console.warn(`[decide] ${p.name} failed: ${err.message}`);
    }
  }
  return mock(normalized);
}

function normalize(req) {
  if (req.kind === 'yesno') return { ...req, options: ['yes', 'no'] };
  if (req.kind === 'score') return { ...req, options: req.levels };
  return req;
}

function finish(req, probabilities, provider) {
  for (const k in probabilities) probabilities[k] = Math.max(0, Number(probabilities[k]) || 0);
  const total = Object.values(probabilities).reduce((a, b) => a + b, 0);
  if (!total) throw new Error('all-zero probabilities');
  for (const k in probabilities) probabilities[k] = Math.round((probabilities[k] / total) * 10000) / 10000;
  const [answer, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return {
    answer: req.kind === 'yesno' ? answer === 'yes' : answer,
    probabilities,
    confidence,
    provider,
  };
}

// ─── 1. OpenAI Decisions API ────────────────────────────────────────────────
// POST /v1/decisions with gpt-6-luna (public beta). Shape verified live, see
// docs/DECISIONS_API.md. Options travel as short values (o1, o2…) with the
// real text in the description, so any option string is safe.
async function openaiDecisions(req) {
  if (!config.openai.apiKey) return null;
  // Diagnosis questions get the root-cause guidance; simple yes/no checks don't.
  const instructions = req.kind === 'yesno' ? req.question : `${req.question} ${DECISIONS_GUIDANCE}`;
  let question;
  if (req.kind === 'yesno') {
    question = { type: 'predicate', name: 'answer', instructions };
  } else if (req.kind === 'score') {
    question = { type: 'score', name: 'answer', instructions, levels: req.options.map((o) => ({ label: String(o) })) };
  } else {
    question = { type: 'choice', name: 'answer', instructions, choices: req.options.map((o, i) => ({ value: `o${i + 1}`, description: String(o) })) };
  }

  const res = await fetch('https://api.openai.com/v1/decisions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // The heuristic prior is left out on purpose: the model makes its own read
    // of the telemetry and log (sending the prior made it copy the fault code).
    body: JSON.stringify({ model: 'gpt-6-luna', input: contextText({ ...req.context, prior: undefined }), questions: [question] }),
  });
  if (!res.ok) throw new Error(`Decisions ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const answer = (await res.json()).answers?.[0];
  if (!answer || answer.type === 'refusal') throw new Error('refused');

  let probabilities;
  if (answer.type === 'predicate') {
    probabilities = { yes: answer.probability, no: 1 - answer.probability };
  } else if (answer.type === 'score') {
    probabilities = Object.fromEntries((answer.probabilities || []).map((p) => [p.label, p.probability]));
  } else {
    const byValue = Object.fromEntries((answer.probabilities || []).map((p) => [p.value, p.probability]));
    probabilities = Object.fromEntries(req.options.map((o, i) => [o, byValue[`o${i + 1}`] ?? 0]));
  }
  return finish(req, probabilities, 'openai-decisions');
}

const DECISIONS_GUIDANCE =
  'A FAULT code names the part whose signal tripped, which is not always the root cause: a failing upstream part ' +
  '(power supply, driver, cooling, fuse) can push a healthy part over its limit. Look at which signals moved first and ' +
  'which part has abnormal readings of its own (e.g. a part whose own temperature is normal is probably not the one failing).';

// The Decisions API takes free text: telemetry and log lines read best as lines.
function contextText(ctx) {
  const c = compactContext(ctx);
  const parts = [];
  for (const [k, v] of Object.entries(c)) {
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) parts.push(`${k}:\n${v.join('\n')}`);
    else parts.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return parts.join('\n\n');
}

// ─── 2. TypeSafe Jev ────────────────────────────────────────────────────────
// TODO: optional. Available via TypeSafe API / OpenRouter / Vercel AI Gateway.
// Text only (no images).
async function jev(req) {
  if (!config.jev.apiKey) return null;
  return null;
}

// ─── 3. GPT with structured output (works today) ────────────────────────────
const SYSTEM = [
  'You are the decision model of a factory maintenance robot. Answer only with calibrated probabilities.',
  'Telemetry lines read: part [status]: signal value (nominal, warn, fail, severity 0=nominal 1=at fail limit, trend over 10 game-minutes).',
  'A FAULT code names the part whose signal tripped, not always the root cause: a failing upstream part (power supply, driver, cooling) can push a healthy part over its limit.',
  'The prior comes from a naive heuristic that trusts fault codes. Override it when the signals or the log point elsewhere.',
].join(' ');

async function gptStructured(req) {
  if (!config.openai.apiKey) return null;
  const properties = Object.fromEntries(req.options.map((o) => [o, { type: 'number' }]));
  const schema = {
    type: 'object',
    properties: { probabilities: { type: 'object', properties, required: req.options, additionalProperties: false } },
    required: ['probabilities'],
    additionalProperties: false,
  };
  const text =
    `${req.question}\n\nAssign a probability (0-1, summing to 1) to each option: ${req.options.join(' | ')}\n\n` +
    `Context: ${JSON.stringify(compactContext(req.context))}`;
  const content = req.image
    ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: req.image } }]
    : text;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: config.openai.model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'decision', strict: true, schema } },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const { probabilities } = JSON.parse(json.choices[0].message.content);
  return finish(req, probabilities, 'gpt-structured');
}

// What the model reads. Telemetry becomes one line per part, numbers are
// rounded, and mock-only fields (hint, forceUncertain) are dropped.
export function compactContext(ctx = {}) {
  const out = {};
  for (const [k, v] of Object.entries(ctx || {})) {
    if (v === undefined || v === null || k === 'hint' || k === 'forceUncertain') continue;
    if (k === 'telemetry' && Array.isArray(v?.parts)) out.telemetry = telemetryLines(v);
    else if (k === 'prior' && typeof v === 'object') out.prior = Object.fromEntries(Object.entries(v).map(([o, p]) => [o, r3(p)]));
    else if (Array.isArray(v) && !v.length) continue;
    else out[k] = v;
  }
  return out;
}

function telemetryLines(t) {
  const codes = t.activeCodes?.length ? `, active codes ${t.activeCodes.join(' ')}` : '';
  const lines = [`${t.machine}: ${t.status}${codes}`];
  for (const p of t.parts) {
    const since = p.status === 'warn' && p.warnForMinutes ? ` ${Math.round(p.warnForMinutes)}m` : '';
    const signals = (p.signals || []).map((s) => {
      const trend = Number(s.trend10m) ? `, trend ${s.trend10m > 0 ? '+' : ''}${r3(s.trend10m)}` : '';
      return `${s.label} ${s.value}${s.unit} (nominal ${s.nominal}, warn ${s.warn}, fail ${s.fail}, severity ${r3(s.severity)}${trend})`;
    });
    lines.push(`${p.name} [${p.status}${since}]: ${signals.join('; ')}`);
  }
  return lines;
}

const r3 = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n);

// ─── 4. Mock ────────────────────────────────────────────────────────────────
// With context.prior: return the prior mapped onto the options (missing → 0.01).
// Without: context.hint gets 85% so demos are predictable.
// context.forceUncertain = true gives a ~54/46 split (shows escalation).
function mock(req) {
  const prior = req.context?.prior;
  if (prior && typeof prior === 'object' && Object.keys(prior).length) {
    const probabilities = Object.fromEntries(
      req.options.map((o) => [o, Number.isFinite(prior[o]) && prior[o] >= 0 ? prior[o] : 0.01]),
    );
    if (Object.values(probabilities).some((p) => p > 0)) return finish(req, probabilities, 'mock');
  }

  const hint = req.context?.hint;
  const probabilities = Object.fromEntries(req.options.map((o) => [o, 0.05]));
  const pick = req.options.includes(hint) ? hint : req.options[0];
  if (req.context?.forceUncertain && req.options.length > 1) {
    const other = req.options.find((o) => o !== pick);
    probabilities[pick] = 0.54;
    probabilities[other] = 0.46;
  } else {
    probabilities[pick] = 0.85;
  }
  return finish(req, probabilities, 'mock');
}

// ─── Free-text lines (speech bubbles, explanations) ─────────────────────────
export async function say(prompt, fallback) {
  if (config.mockAi || !config.openai.apiKey) return fallback;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: config.openai.model,
        messages: [
          { role: 'system', content: 'You are Wrench-bot, a cheerful factory maintenance robot. Reply in one short sentence (max 18 words).' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const json = await res.json();
    return json.choices?.[0]?.message?.content?.trim() || fallback;
  } catch {
    return fallback;
  }
}
