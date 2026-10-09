# Wrench-bot Factory

**Team Reapin' It In · Reap × 65labs Agentic Buildathon · 9 Oct 2026**
**Track: Most Worthwhile Problem** (also relevant to Best Bridge Between Onchain and Real World)

> A factory you can play, where an AI maintenance agent reads live sensor logs, works out which part actually failed, buys the replacement through Reap's Agentic Payments, and pays the technician in USDC onchain — all inside spending rules the manager controls.

## The problem
When a machine stops, every minute costs money, and getting it running again is slow and manual: someone reads the alarms, guesses the part, finds a supplier, gets purchasing approval, waits for delivery, books a technician, and pays them. Alarms are often misleading — the part that throws the fault code is not always the part that is broken — so the wrong part gets ordered and the line stays down even longer.

## What we built
A simulated factory (Three.js) with four machines and 15 parts. Every part has hidden health; it shows up only as sensor signals (temperature, vibration, voltage, signal strength…) and a plant log of WARN/FAULT lines — exactly what a real maintenance team sees. Failures ripple: a sagging 24 V supply makes the gripper servo throw the fault.

**Wrench-bot**, the agent, handles each breakdown end to end:
1. **Diagnoses from the logs** with the **OpenAI Decisions API** (`gpt-6-luna`, typed choice with probabilities). In the *Brownout* scenario the fault code points at the servo; the model reads the falling 24 V rail and picks the power supply (59–98% depending on the evidence) — and the game shows the naive "fault-code rule" next to it.
2. **Finds the replacement live** in Reap's catalog (Agentic product search), ranks listings by spec, price and trusted stores.
3. **Gets a real quote** from the merchant (Reap quotes: price, shipping, tax, expiry).
4. **Checks the manager's rules in code** — auto-approve limit, monthly budget, confidence threshold, trusted stores. The model only recommends; it can never overspend.
5. **Pays**: through Reap's checkout with the manager's one-tap approval on Reap's hosted page (escalated orders show the reasons: over limit, over budget, not sure enough). Untrusted stores are blocked outright.
6. **Ships, repairs, verifies**: a technician is dispatched; after the swap, the simulation's telemetry decides whether the fix worked. If not, the agent rules that part out and re-diagnoses.
7. **Pays the technician onchain**: a real USDC transfer on Ink Sepolia from the factory treasury, released only after the repair is verified (escrow logic), with the transaction linked in the log.

## Onchain ↔ real world
- The factory treasury is a wallet that **owns a Kwal (Payward) USDC vault** on Ink Sepolia. We deployed and funded the vault onchain (8 USDC, card-spendable) — the vault is the hard, onchain cap on what the agent's card can spend.
- **Technician payouts are real USDC transfers** (testnet, scaled 1:100 so faucet funds last: a $120 job pays 1.20 USDC).
- Within-limit parts orders are wired to pay **from the Kwal vault** (no approval page — the deposit is the authorization). At the time of submission Kwal's variant/quote endpoints returned `400 ParticipantBadRequest` for every product, so the agent automatically falls back to the Reap card and logs why.

## Scenario presets (each shows one idea)
| Scenario | What it shows |
|---|---|
| Sensor burnout | A cheap part dies; within the limit → the agent handles it end to end |
| Brownout | Misleading fault code; reading the logs vs trusting the alarm; re-diagnosis |
| Grinding noise | Predictive maintenance: rising vibration → part ordered before the line stops |
| Month-end crunch | Over-budget orders escalate to the manager |
| Supplier gap | The only listing is from an untrusted store → blocked until the manager trusts it |
| Free play | Random wear, one failure at a time; chaos tools and the Manager's Desk |

## How it uses Reap
Enrollment (hosted card entry) → product search → product details/variant → quote → shipping option → checkout → hosted approval → order status. Everything runs against the Reap sandbox with the team key. Findings: `Reap-Version: 2025-02-14` is required; checkout return URLs must be public HTTPS; mixed-merchant carts are rejected (one checkout per store); in the sandbox every checkout needs a one-tap approval (mandates aren't live yet).

## Tech
Node + Express server (simulation engine, agent orchestrator, Reap + Kwal clients, viem for Ink Sepolia), Vite + Three.js client, Server-Sent Events between them. Decision layer: OpenAI Decisions API → GPT structured output → offline heuristic fallback.

## Honest limits
- Factory, technicians and deliveries are simulated; payments, catalog, quotes and the vault are real sandbox/testnet systems.
- Kwal vault purchases fall back to the Reap card while Kwal's quote endpoint is failing.
- Technician payouts are testnet USDC, scaled 1:100.
