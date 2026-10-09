# Wrench-bot Factory

A playable factory where an AI maintenance agent reads live sensor logs, diagnoses the real root cause, buys the replacement part through **Reap Agentic Payments**, and pays the technician in **USDC onchain** — within spending rules the manager sets.

Reap × 65labs Agentic Buildathon · Team Reapin' It In. Write-up: [docs/SUBMISSION.md](docs/SUBMISSION.md) · idea: [IDEA.md](IDEA.md).

## Run
```bash
npm install
cp .env.example .env      # add REAP_API_KEY, OPENAI_API_KEY (and optionally the onchain keys)
npm run dev               # server on :8787, game on http://localhost:5173
```
Offline (no keys, simulated payments): `npm run dev:mock`.

Optional setup:
- Card for Reap checkouts: `npm run reap:enroll -w server`, enter the card on Reap's hosted page, put the printed `REAP_ENROLLMENT_ID` in `.env`.
- Onchain: `TREASURY_PRIVATE_KEY` (Ink Sepolia testnet wallet with test USDC) enables real technician payouts; the Kwal vault comes from the [Kwal agent skill](https://github.com/payward/kwal-skill) (`register` + `setup --owner-address <treasury>`).

## Layout
- `shared/contract.js` — machines, parts, sensor signals, scenario presets, event types
- `server/src/sim` — the simulation (hidden part health → signals → plant log)
- `server/src/agent` — monitor, diagnosis (OpenAI Decisions API), policy, technicians
- `server/src/reap`, `server/src/catalog` — Reap Agentic client, live catalog
- `server/src/chain`, `server/src/kwal` — Ink Sepolia USDC (viem), Kwal vault rail
- `game/src` — Three.js world + DOM UI, driven by server-sent events
