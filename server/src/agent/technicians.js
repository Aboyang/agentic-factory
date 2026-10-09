// Technician marketplace (Reap sells products, not services) with ONCHAIN payouts.
//
// Escrow lock = an offchain reservation made when the technician is dispatched.
// Release = a real USDC transfer on Ink Sepolia (testnet) from the factory
// treasury to the technician's wallet, after the repair has been checked.
// Payout = rate × TECH_PAYOUT_SCALE (default 0.01: a $120 job pays 1.20 USDC).
// Falls back to a simulated payout (escrow.onchain = false + simulatedReason)
// when the chain is off, the treasury is short, or the transfer fails. Never throws.
//
//   lockEscrow(technician, incidentId, { amountUsdc? })  → escrow (LOCKED)
//   releaseEscrow(escrow)                                → Promise<escrow (RELEASED)>, idempotent per escrow.id
//   confirmPayout(escrow)                                → Promise<{ confirmed, error? }> for a payout still being mined

import '../config.js'; // .env first
import { randomUUID } from 'node:crypto';
import { treasury, technicianAddress, sendUsdc, confirmUsdc, usdcBalance, ethBalance, txUrl } from '../chain/usdc.js';
import { chainActive, chainOffReason, refreshAfterPayout } from '../chain/treasury.js';

export const TECHNICIANS = [
  { id: 'tech-ana', name: 'Ana', skills: ['sensors', 'electrical'], rating: 4.9, rate: 120, color: '#f4a261' },
  { id: 'tech-raj', name: 'Raj', skills: ['motors', 'servos'], rating: 4.7, rate: 110, color: '#2a9d8f' },
  { id: 'tech-mei', name: 'Mei', skills: ['networking', 'electrical'], rating: 4.8, rate: 100, color: '#e76f51' },
];

const scaleEnv = Number(process.env.TECH_PAYOUT_SCALE);
export const PAYOUT_SCALE = Number.isFinite(scaleEnv) && scaleEnv > 0 ? scaleEnv : 0.01;
/** '(testnet, scaled 1:100)' */
export const PAYOUT_NOTE = `testnet, scaled ${PAYOUT_SCALE >= 1 ? `${PAYOUT_SCALE}:1` : `1:${Math.round(1 / PAYOUT_SCALE)}`}`;

const SEND_TIMEOUT_MS = 25_000; // broadcast (nonce + gas estimate + send)
const CONFIRM_TIMEOUT_MS = 45_000; // mined receipt
const BALANCE_TIMEOUT_MS = 8_000;

export const payoutUsdc = (technician) => round6((technician?.rate || 0) * PAYOUT_SCALE);
export const usdcText = (n) => `${(Number(n) || 0).toFixed(2)} USDC`;

export function lockEscrow(technician, incidentId, { amountUsdc } = {}) {
  const onchain = chainActive();
  return {
    id: `esc_${randomUUID().slice(0, 8)}`,
    incidentId,
    technicianId: technician.id,
    technicianName: technician.name,
    amount: technician.rate, // job price in dollars (laborSpend uses this)
    currency: 'USD',
    amountUsdc: round6(amountUsdc ?? payoutUsdc(technician)), // what is actually paid onchain
    payoutCurrency: 'USDC',
    scale: PAYOUT_SCALE,
    to: technicianAddress(technician.id),
    network: 'Ink Sepolia',
    reservation: 'offchain',
    status: 'LOCKED',
    onchain, // planned rail; the RELEASED escrow says what really happened
    simulated: !onchain,
    lockedAt: new Date().toISOString(),
  };
}

// One release per escrow id, ever: a second call returns the first call's promise.
const releases = new Map();

export function releaseEscrow(escrow) {
  if (!escrow?.id) return Promise.resolve(simulated(escrow || {}, 'no escrow'));
  if (!releases.has(escrow.id)) {
    releases.set(escrow.id, settle(escrow).catch((err) => simulated(escrow, `payout error: ${brief(err)}`)));
  }
  return releases.get(escrow.id);
}

/** For a payout broadcast but not mined in time: resolves once the receipt lands (or definitively doesn't). */
export async function confirmPayout(escrow, { timeoutMs = 180_000 } = {}) {
  if (!escrow?.txHash) return { confirmed: false, error: 'no transaction' };
  try {
    const r = await confirmUsdc(escrow.txHash, { timeoutMs });
    refreshAfterPayout();
    return { confirmed: true, blockNumber: r.blockNumber };
  } catch (err) {
    return { confirmed: false, error: brief(err) };
  }
}

async function settle(escrow) {
  if (!chainActive()) return simulated(escrow, chainOffReason() || 'onchain payouts off');
  if (!escrow.to) return simulated(escrow, `no payout wallet for ${escrow.technicianId}`);
  if (!(escrow.amountUsdc > 0)) return simulated(escrow, 'nothing to pay');
  return serial(() => transfer(escrow));
}

async function transfer(escrow) {
  // Can the treasury pay? A failed read is not a "no": the transfer itself will tell.
  const [usdc, eth] = await Promise.allSettled([
    timed(usdcBalance(treasury.address), BALANCE_TIMEOUT_MS),
    timed(ethBalance(treasury.address), BALANCE_TIMEOUT_MS),
  ]);
  if (usdc.status === 'fulfilled' && usdc.value < escrow.amountUsdc) {
    return simulated(escrow, `treasury holds ${usdc.value.toFixed(2)} USDC, needs ${escrow.amountUsdc.toFixed(2)}`);
  }
  if (eth.status === 'fulfilled' && eth.value <= 0) return simulated(escrow, 'treasury has no ETH for gas');

  let hash;
  try {
    hash = await timed(sendUsdc(escrow.to, escrow.amountUsdc), SEND_TIMEOUT_MS);
  } catch (err) {
    return simulated(escrow, `transfer failed: ${brief(err)}`);
  }
  console.log(`[payout] ${escrow.id}: ${escrow.amountUsdc} USDC → ${escrow.to} tx ${hash}`);

  try {
    const r = await confirmUsdc(hash, { timeoutMs: CONFIRM_TIMEOUT_MS });
    refreshAfterPayout();
    return released(escrow, { onchain: true, simulated: false, txHash: hash, txUrl: r.url, blockNumber: r.blockNumber, confirmed: true });
  } catch (err) {
    if (/revert/i.test(err.message)) {
      return simulated(escrow, `transfer reverted onchain`, { txHash: hash, txUrl: txUrl(hash) });
    }
    // Broadcast but not mined yet: it is a real payment, just unconfirmed. Never resend.
    refreshAfterPayout();
    return released(escrow, { onchain: true, simulated: false, txHash: hash, txUrl: txUrl(hash), confirmed: false, pending: brief(err) });
  }
}

function released(escrow, extra) {
  return { ...escrow, status: 'RELEASED', releasedAt: new Date().toISOString(), ...extra };
}

function simulated(escrow, reason, extra = {}) {
  return released(escrow, { onchain: false, simulated: true, simulatedReason: reason, ...extra });
}

// One transfer at a time from the treasury so two payouts never race for a nonce.
let tail = Promise.resolve();
function serial(fn) {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

function timed(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function brief(err) {
  const msg = err?.shortMessage || err?.message || String(err);
  return msg.split('\n')[0].slice(0, 140);
}

function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}
