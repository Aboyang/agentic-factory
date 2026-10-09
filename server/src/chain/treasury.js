// Treasury state for the game: the factory's onchain wallet (Ink Sepolia), the
// Kwal vault it owns, and Kwal's setup/funding state. Polled every 20 s and
// right after each payout (plus ~6 s later: load-balanced RPC reads can lag a
// mined receipt). Shape documented at the bottom of shared/contract.js:
//   { onchain, address, vaultAddress, usdc, vaultUsdc, eth, explorer: { treasury, vault },
//     kwal: { enabled, step, state, cardStatus, availableUsdc }, network, chainId, updatedAt, error }
//
//   startTreasury()        begin polling (idempotent), emits EVENTS.TREASURY_UPDATED { treasury }
//   getTreasury()          current object (for STATE and GET /api/treasury)
//   refreshTreasury()      poll now (coalesces concurrent calls)
//   refreshAfterPayout()   poll now and again ~6 s later
//   chainActive()          onchain payouts allowed (key set, ONCHAIN!=0, not offline MOCK_REAP mode)
//   chainOffReason()       why not, for logs

import { EVENTS } from '../../../shared/contract.js';
import { config } from '../config.js';
import { emit } from '../events.js';
import { treasury as account, onchainEnabled, usdcBalance, ethBalance, addressUrl } from './usdc.js';
import { kwal, kwalState, kwalAmount } from '../kwal/client.js';
import { kwalRailEnabled } from '../kwal/rail.js';

const POLL_MS = Number(process.env.TREASURY_POLL_MS) || 20_000;
const READ_TIMEOUT_MS = 10_000;
const SETTLE_DELAY_MS = 6_000;
const DEFAULT_VAULT = '0x14735b01eD166F386EFE0aD27A2791498b44572f';

export const chainActive = () => onchainEnabled && !config.mockReap;

export function chainOffReason() {
  if (!account) return 'no treasury key configured';
  if (process.env.ONCHAIN === '0') return 'onchain switched off, ONCHAIN=0';
  if (config.mockReap) return 'offline mode, MOCK_REAP';
  return null;
}

let vaultAddress = process.env.KWAL_VAULT_ADDRESS || DEFAULT_VAULT;
let state = blank();
let timer = null;
let inflight = null;

function blank() {
  return {
    onchain: chainActive(),
    network: 'Ink Sepolia',
    chainId: 763373,
    address: account?.address || null,
    vaultAddress,
    usdc: null,
    vaultUsdc: null,
    eth: null,
    explorer: { treasury: account ? addressUrl(account.address) : null, vault: addressUrl(vaultAddress) },
    kwal: { enabled: kwalRailEnabled(), step: null, state: null, cardStatus: null, availableUsdc: null },
    updatedAt: null,
    error: null,
  };
}

export function getTreasury() {
  return { ...state, explorer: { ...state.explorer }, kwal: { ...state.kwal } };
}

export function startTreasury() {
  if (timer) return;
  refreshTreasury();
  timer = setInterval(refreshTreasury, POLL_MS);
  timer.unref?.();
}

export function refreshTreasury() {
  if (!inflight) {
    inflight = poll()
      .catch((err) => {
        state = { ...state, error: err.message };
      })
      .then(() => {
        emit(EVENTS.TREASURY_UPDATED, { treasury: getTreasury() });
        return getTreasury();
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function refreshAfterPayout() {
  refreshTreasury();
  setTimeout(refreshTreasury, SETTLE_DELAY_MS).unref?.();
}

async function poll() {
  const prev = state;
  const next = { ...blank(), usdc: prev.usdc, vaultUsdc: prev.vaultUsdc, eth: prev.eth, kwal: { ...prev.kwal, enabled: kwalRailEnabled() } };
  const errors = [];

  // Kwal first: its status names the vault address the balance read should use.
  if (next.kwal.enabled) {
    const [status, funding] = await Promise.allSettled([timed(kwal.status()), timed(kwal.funding())]);
    if (status.status === 'fulfilled') {
      const s = status.value || {};
      next.kwal.step = kwalState(s.state);
      next.kwal.cardStatus = s.cardStatus || null;
      if (/^0x[0-9a-fA-F]{40}$/.test(s.vaultAddress || '')) vaultAddress = s.vaultAddress;
    } else errors.push(`kwal status: ${status.reason?.code || status.reason?.message}`);
    if (funding.status === 'fulfilled') {
      next.kwal.state = kwalState(funding.value?.state);
      next.kwal.availableUsdc = kwalAmount(funding.value?.available);
    } else errors.push(`kwal funding: ${funding.reason?.code || funding.reason?.message}`);
  } else {
    next.kwal = { enabled: false, step: null, state: null, cardStatus: null, availableUsdc: null };
  }
  next.vaultAddress = vaultAddress;
  next.explorer.vault = addressUrl(vaultAddress);

  if (next.onchain) {
    const [usdc, vault, eth] = await Promise.allSettled([
      timed(usdcBalance(account.address)),
      timed(usdcBalance(vaultAddress)),
      timed(ethBalance(account.address)),
    ]);
    if (usdc.status === 'fulfilled') next.usdc = round(usdc.value, 6);
    else errors.push(`usdc: ${usdc.reason?.shortMessage || usdc.reason?.message}`);
    if (vault.status === 'fulfilled') next.vaultUsdc = round(vault.value, 6);
    else errors.push(`vault: ${vault.reason?.shortMessage || vault.reason?.message}`);
    if (eth.status === 'fulfilled') next.eth = round(eth.value, 8);
    else errors.push(`eth: ${eth.reason?.shortMessage || eth.reason?.message}`);
  } else {
    // No chain reads at all; the Kwal funding read (if any) still knows the vault balance.
    next.usdc = null;
    next.eth = null;
    next.vaultUsdc = null;
  }
  if (next.vaultUsdc === null && next.kwal.availableUsdc !== null) next.vaultUsdc = next.kwal.availableUsdc;

  next.updatedAt = new Date().toISOString();
  next.error = errors.length ? errors.join('; ') : null;
  if (errors.length) console.warn(`[treasury] ${next.error}`);
  state = next;
}

function timed(promise, ms = READ_TIMEOUT_MS) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
