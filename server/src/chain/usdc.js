// Real USDC on Ink Sepolia (testnet). The factory treasury wallet owns the Kwal
// vault and pays technicians onchain after a verified repair.
//   balances()                    → { treasury, vault } in USDC (numbers)
//   payUsdc(to, amount, memo)     → { hash, url } once the transfer is mined
// Keys live only in .env (TREASURY_PRIVATE_KEY). Nothing here runs without it.

import '../config.js'; // loads .env before the key and RPC URL are read below
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const USDC = '0xFabab97dCE620294D2B0b0e46C68964e326300Ac'; // from Kwal's funding instructions
const DECIMALS = 6;
const EXPLORER = 'https://explorer-sepolia.inkonchain.com';

export const inkSepolia = defineChain({
  id: 763373,
  name: 'Ink Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.INK_RPC_URL || 'https://rpc-gel-sepolia.inkonchain.com'] } },
  blockExplorers: { default: { name: 'Ink Sepolia Explorer', url: EXPLORER } },
  testnet: true,
});

const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

const key = process.env.TREASURY_PRIVATE_KEY;
export const treasury = key ? privateKeyToAccount(key) : null;
export const onchainEnabled = Boolean(treasury) && process.env.ONCHAIN !== '0';

const pub = createPublicClient({ chain: inkSepolia, transport: http() });
const wallet = treasury ? createWalletClient({ account: treasury, chain: inkSepolia, transport: http() }) : null;

// Technician payout addresses. Public addresses only (no keys) as defaults, so a
// deploy without server/.cache/wallets.json still pays the same wallets; a local
// wallets.json overrides them.
const techWallets = {
  'tech-ana': '0x4034E929372b8c422EdE4026AD4788Bc88470E3b',
  'tech-raj': '0x4eb0794b30d9f0f6Ac35424106b4EcddA98B5A5d',
  'tech-mei': '0x7b873045c69a8c408401e23f792c1C5B03CA6bfA',
};
try {
  const file = fileURLToPath(new URL('../../.cache/wallets.json', import.meta.url));
  for (const t of JSON.parse(fs.readFileSync(file, 'utf8')).technicians || []) {
    if (/^0x[0-9a-fA-F]{40}$/.test(t?.address || '')) techWallets[t.id] = t.address;
  }
} catch {
  // no local wallets file: keep the defaults
}
export const technicianAddress = (id) => techWallets[id] || null;

export const txUrl = (hash) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (addr) => `${EXPLORER}/address/${addr}`;

export async function usdcBalance(address) {
  const raw = await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [address] });
  return Number(formatUnits(raw, DECIMALS));
}

export async function ethBalance(address) {
  return Number(formatUnits(await pub.getBalance({ address }), 18));
}

/** Broadcast a USDC transfer from the treasury; resolves with the tx hash (not yet mined). */
export async function sendUsdc(to, amount) {
  if (!wallet) throw new Error('No TREASURY_PRIVATE_KEY configured');
  const value = parseUnits(Number(amount).toFixed(DECIMALS), DECIMALS);
  return wallet.writeContract({ address: USDC, abi: ERC20, functionName: 'transfer', args: [to, value] });
}

/** Wait for a transfer's receipt. Throws if it reverted or did not land within timeoutMs. */
export async function confirmUsdc(hash, { timeoutMs = 90_000 } = {}) {
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: timeoutMs });
  if (receipt.status !== 'success') throw new Error(`Transfer reverted (${hash})`);
  return { hash, url: txUrl(hash), blockNumber: Number(receipt.blockNumber) };
}

/** Send USDC from the treasury and wait for the receipt. */
export async function payUsdc(to, amount) {
  return confirmUsdc(await sendUsdc(to, amount));
}
