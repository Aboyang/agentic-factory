# Wrench-bot Factory *(working title)*

**Team Reapin' It In · Reap × 65labs Agentic Buildathon · 9 October 2026**

> A pixel-art factory game where machines break and an AI agent buys the replacement parts with real (sandbox) Reap payments, within spending rules the player sets.

---

## 1. The pitch

Factories lose money every minute a machine is down. Today, fixing a breakdown means someone works out what failed, finds the part, gets purchasing approval, waits for delivery and books a technician. That's hours of back-and-forth while the line sits idle.

**Wrench-bot Factory** turns that process into a playable sandbox. Machines run, things break, and **Wrench-bot**, an AI maintenance agent, diagnoses the fault, finds the exact replacement part in real merchant catalogs, prices it with a live Reap quote, and pays. It acts on its own when it's confident and within budget, and **asks the human manager** when it isn't.

Payment authority is the core of the game, not a hidden setting: the player tunes the agent's spending rules and immediately sees what that costs or saves.

**Prize track:** Most Worthwhile Problem. Stretch: Best Bridge Between Onchain and Real World, through technician escrow in USDC.

---

## 2. What the player sees

A top-down pixel-art factory floor (Stardew / Factorio style):

- **4 machines** connected by conveyors: **Conveyor → Sorter → Robot Arm → Packer**
- Items flow along the belts, and **coins** tick up as finished products ship
- A **downtime meter** (−$/min) that starts burning when anything stops
- **Wrench-bot**: a small robot that walks around the floor
- **The Manager's Desk**: a room where the player sets the agent's spending rules
- **The procurement terminal**: a pixel popup showing real product images and prices from Reap
- **A delivery truck** and **technician NPCs** that arrive when called
- **The chaos button**: triggers a failure scenario on demand (for demos and play)

---

## 3. The core loop

```
 Machine running ──► 💥 Breaks (sparks, smoke, belt stops, −$40/min starts)
                          │
                          ▼
 🤖 Wrench-bot walks over and inspects
      • GPT writes the diagnosis ("Proximity sensor not responding")
      • Jev scores severity and picks the right part from the candidates
                          │
                          ▼
 🖥️ Procurement terminal: real Reap product search → quote (price + shipping)
                          │
            ┌─────────────┴──────────────┐
            ▼                            ▼
  Under limit AND confident      Over limit OR unsure
  → buys automatically           → "?" over the robot's head
                                 → Manager approves on Reap's approval page
            └─────────────┬──────────────┘
                          ▼
 🚚 Truck delivers (shipping days compressed into game seconds)
                          ▼
 👷 Technician walks in and repairs (escrow pays when the fix is confirmed)
                          ▼
 ✅ Machine back online, coins flow again, incident logged
```

---

## 4. The agent: fast decisions, slow reasoning, hard limits

The agent has three layers, each with one job.

| Layer | Powered by | Job |
|---|---|---|
| **Fast decisions** | **Jev** (TypeSafe AI) | Quick, structured calls every game tick, each returning probabilities and a confidence figure |
| **Slow reasoning** | **OpenAI GPT** (hackathon credits) | Diagnosis, the robot's speech bubbles, explaining purchases, the incident report |
| **Hard limits** | **Plain code + Reap approval** | Spending caps, budget, approved stores. These are never left to a model. |

### What Jev decides
Jev evaluates the game state against typed questions:

| Question | Jev type | Example output |
|---|---|---|
| How severe is this failure? | score (1–5) | `4 · confidence 0.91` |
| Which replacement part is correct? | choice (from search results) | `PIP-T18L-001: 0.88, PIP-T12L-001: 0.09, …` |
| Buy now, wait, or ask the manager? | choice | `buy_now: 0.72, escalate: 0.25, wait: 0.03` |
| Which technician should go? | choice | `Tech #2 (servo specialist): 0.81` |
| Is the machine fixed? | yes/no | `yes · 0.95` |

> Note: Jev is from **TypeSafe AI**, not OpenAI. Its founder previously worked at OpenAI. It's available through TypeSafe's API, OpenRouter and the Vercel AI Gateway. We need our own API key; the hackathon credits only cover OpenAI. **Fallback:** if Jev isn't available, GPT answers the same typed questions behind the same interface.

### The rule that makes it a payments product
**The agent pays when it's sure and asks when it isn't.**

- High confidence **and** under the auto-approve limit → the agent buys on its own
- Low confidence (e.g. "sensor 54% / relay 46%") → the agent stops, the game shows Jev's probability bars, and the manager decides
- Over the limit or over budget → always escalated, whatever the confidence

The model only **recommends**. Code enforces the limits, and Reap's hosted approval page enforces the final charge. If a judge asks "what stops the AI from overspending?", that's the answer.

---

## 5. Spending controls as a game mechanic

**The Manager's Desk** is an in-game room where the player sets:

| Control | Example | Effect in game |
|---|---|---|
| Auto-approve limit | slider, $0–$500 | Below it, the robot buys alone. Above it, you get an approval request. |
| Monthly maintenance budget | $1,000 bar that drains | When it's empty, everything needs approval. |
| Approved stores | checkboxes | The agent can only buy from these. |
| Express shipping rule | "critical machines only" | Faster fix, higher cost. |
| Confidence threshold | slider, 50–95% | Below it, the agent always asks. |

**The trade-off is the game:** set the limits too low and the factory waits on your approvals while downtime burns money. Set them too high and you overspend. The end-of-shift score combines output, downtime and spend.

---

## 6. Payments: how Reap is used

Each purchase runs the full Reap Agentic flow (sandbox):

1. **Enrollment:** the manager stores a card once on Reap's hosted page (we never see the card number)
2. **Product search:** `POST /agentic/products/search` → real merchant products with images
3. **Product details / variant:** resolve the exact purchasable variant
4. **Quote:** `POST /agentic/quotes` → live price, shipping options, tax and expiry
5. **Shipping option:** express for critical machines, standard otherwise
6. **Checkout:** `POST /agentic/checkouts` → either charges under approved terms, or returns a Reap approval link (shown in game as a link or QR code for the manager's phone)
7. **Confirm:** `GET /agentic/checkouts/:id` → order reference, shown on the delivery truck

### Error states shown as game moments
| What happens | What the player sees |
|---|---|
| Quote expired (~15 min) | Robot re-prices: "Price refreshed, now $53.10" |
| Part out of stock | Robot picks the next best part and shows why |
| Manager rejects | Machine stays down and the downtime meter keeps climbing |
| Parts from 2 stores | Two separate approvals (Reap needs one checkout per store) |
| Over budget | Red budget bar, "Needs manager approval" |
| Payment declined | Robot shows the error and suggests another card |

---

## 7. Technicians (simulated, with optional onchain escrow)

Reap sells physical products, not services, so the **technician marketplace is simulated**: a few NPC technicians with skills (sensors, motors, electrical), ratings and rates.

**Stretch goal: pay-on-fix escrow in USDC (test network)**
- When Wrench-bot books a technician, it locks the fee (e.g. $120 USDC) in escrow
- When the machine's sensor reports healthy (Jev yes/no: "is it fixed?"), the escrow releases automatically
- **The money only moves when the fix is confirmed.** That's the onchain ↔ real-world story for prize track 2.

If time runs short, simulate the escrow in the game and say so in the submission.

---

## 8. Failure scenarios (real parts, checked against the Reap sandbox)

Every scenario maps to a part we have **already quoted successfully** in the sandbox. We pin these variant IDs so the demo never misses; live search still runs alongside.

| # | Machine | Failure | Replacement part | Store | Live quote (US, incl. shipping) |
|---|---|---|---|---|---|
| 1 | Sorter | Item detection stops | NO 5mm PNP inductive proximity sensor (PIP-T18L-001) | Switch Electronics | **$52.05** |
| 2 | Robot Arm | Power and control failure | 24V 4.5A 100W PSU + 12V 4-ch relay board + e-stop button | Switch Electronics | **$90.16** (one quote) |
| 3 | Conveyor | Drive motor stalls | Creality 42-40 stepper motor | Digitmakers | **$30.00** |
| 4 | Packer | Network drops, line goes offline | TP-Link TL-SG108PE PoE switch | Tech For Less | **$64.06** |
| 5 | Robot Arm | Gripper servo burns out | FT5330M 35kg digital servo | Switch Electronics | (to quote) |

Other parts available for more scenarios: limit switches, DC motors, motor drivers, fuses, indicator lights, cooling fans, bearings, Arduino boards, a UPS, barcode scanners, and multimeters and thermal cameras for the technician's toolkit.

---

## 9. Demo script (~2 minutes)

1. **Intro (10s):** the factory is running, coins ticking up. "This is a real agent with real (sandbox) payments."
2. **Small failure (25s):** chaos button → the sorter's sensor dies. The robot walks over, diagnoses, the terminal shows the real product and the **$52.05** quote. Under the limit and confident → **buys on its own**, and the order number appears.
3. **Big failure (35s):** the robot arm fails, **$90+**, over the limit. The robot shows "?" and Jev's probability bars. **The manager approves on their phone** through Reap's page.
4. **Repair (20s):** the truck arrives, the technician fixes the arm, the escrow releases, the machine turns green.
5. **Controls (20s):** at the Manager's Desk, raise the limit and trigger another failure: now it auto-buys. Lower the budget: now everything escalates.
6. **Wrap-up (10s):** "3 incidents, $206 spent, 41 minutes of downtime avoided."

---

## 10. How this maps to the judging criteria

| Criterion | How we meet it |
|---|---|
| **Technical merit:** Agentic integration, payment authority, spending controls | Full Reap flow (search → quote → checkout → approval). Rules enforced in code and by Reap. Jev confidence decides when to ask a human. |
| **Polish:** approval, error and payment states | Every state is a visible in-game moment (expired quote, out of stock, rejection, over budget, two stores) |
| **Execution:** a working core, demonstrated convincingly | Pinned scenarios with parts already quoted. One full loop working before any extra features. |
| **Wow factor:** originality, memorable demo | A playable game where an AI spends real (sandbox) money, and you can watch it decide |

---

## 11. Tech stack

| Part | Choice | Why |
|---|---|---|
| Game | **Phaser 3 + Vite** (browser) | Sprites, tilemaps, animations and tweens built in. Fast to build. |
| Art | Free CC0 pixel packs (Kenney.nl, itch.io factory tilesets) | No time to draw everything. Custom sprites only for Wrench-bot and the breakdown effects. |
| Backend | **Node + Express** | Holds the Reap and AI keys (never in the browser), runs the agent loop, sends events to the game (WebSocket or SSE) |
| Fast decisions | **Jev** via TypeSafe or OpenRouter | Typed choice, score and yes/no calls with confidence |
| Reasoning | **OpenAI GPT** | Diagnosis, dialogue, incident reports |
| Payments | **Reap Agentic API** (sandbox) | Required by the hackathon |
| Escrow (stretch) | USDC on a test network | Pay on confirmed fix |

### Reap sandbox facts we confirmed with live calls
- Every request needs the header **`Reap-Version: 2025-02-14`**. The docs don't state the value; the API returns it in a validation error.
- A quote needs `email` and a `shippingAddress` with `firstName`, `lastName`, `phone` (format `+14155550123`), `addressLine1`, `city` and `country`.
- Quotes take about **10 seconds** and **expire after about 15 minutes**.
- Several items from **one store** can share a quote. **Mixed stores are rejected** (`AGENTIC_REQUEST_REJECTED`), so we need one checkout per store.
- **Search results vary between runs**, so pin variant IDs for the demo.
- In the sandbox, checkout accepts the `X-Simulate-Checkout: COMPLETED` header.
- About 1,750 purchasable products are saved in `catalogs/reap_catalog.csv`.

---

## 12. Build plan (about 4 hours)

| Time (SGT) | Game | Backend / agent | Third person |
|---|---|---|---|
| **→ 6:00** | Tile map, 4 machines, conveyor animation | **One full loop:** failure → search → quote → checkout → approval | Collect art packs, pin scenario variant IDs, get a Jev key |
| **6:00–7:30** | Break and repair animations, robot walking, terminal popup | Policy engine, game events, GPT diagnosis, Jev decisions | Manager's Desk UI |
| **7:30–8:15** | Connect everything, show error states in game | Escrow (stretch) | Demo script, record backup video |
| **8:15–8:45** | Polish and bug fixes | Polish and bug fixes | Write the submission |
| **8:45** | **Submit** (deadline 9:00 sharp) | | |

**The rule that matters most:** one ugly but working full loop by **6 pm**. Polish and Jev come after.

---

## 13. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Jev key unavailable or slow | GPT answers the same typed questions behind the same interface |
| Reap search returns different results | Pinned variant IDs per scenario |
| Quote expires mid-demo | Re-quote automatically (and show it as a feature) |
| Pixel art takes too long | Use asset packs as they are; colored boxes plus effects are fine |
| Live demo breaks | Pre-recorded backup video of the full loop |
| Escrow not finished | Simulate it in game and say so honestly in the submission |

---

## 14. Rules we follow

- Sandbox only. Checkout is simulated, and nothing real is bought or delivered.
- All purchases go through Reap's Agentic module, with no scraping of checkout pages.
- Card details are entered only on Reap's hosted page and never reach our code or any AI model.
- API keys live on the backend (`.env`, git-ignored), never in the game client.

---

### Sources
- [Reap Agentic Payments docs](https://docs.reap.global/agentic-payments/overview)
- [Hackathon participant guide](https://reap-hackathon-microsite.vercel.app/)
- [What is Jev AI decision model (2026)](https://pooyagolchian.com/blog/what-is-jev-ai-decision-model-2026/)
- [Jev AI decision model review (Wavect)](https://wavect.io/de/blog/jev-ai-decision-model-review.md)
- [TypeSafe Jev on Runware](https://runware.ai/models/typesafe-jev)
