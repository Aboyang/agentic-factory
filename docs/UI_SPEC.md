# UI simplification (supersedes the layout in SIM_SPEC §7)

Goal: the 3D factory is the hero. Only essentials are on screen by default;
details pop up when you click something. Reuse the existing modules
(Hud, PlantLog, Inspector, agentpanel, desk, chaos, catalogpanel, ScenarioPicker) —
change layout and visibility, not the data plumbing.

## Default screen (nothing else visible)
1. **3D world** fills the window.
2. **Top bar (one slim line, top-left):** shift clock · scenario name · money
   (revenue, downtime in red, parts spend) · budget mini-bar · speed controls
   (pause 1× 2× 4× 8×) · a ☰ MENU button.
3. **Terminal log (bottom-right corner, small, ~380×190 px):** black background,
   monospace (VT323), terminal look: blinking cursor line, prompt-like rows
   `08:14 FAULT E-ARM-310 Robot Arm  Gripper position error …`. Colors: INFO grey,
   AGENT cyan, WARN amber, ERROR/FAULT red. Header with tiny tabs ALL · ALERTS · AGENT
   and a minimize/expand toggle (expand → ~640×420). Autoscroll unless scrolled up.
4. **Agent status chip (top-centre, only while an incident is open):**
   `🔧 Robot Arm · Diagnosing… 2/7` with a progress dot row. Click → agent popup.
   Several incidents → several chips.
5. **Speech bubble** over Wrench-bot (keep) and **floating text** over machines
   on status changes (keep).
6. **Approval modal** pops automatically when the agent needs the manager (essential action).
7. **Machine hint labels:** a small chip floats above a machine ONLY when it is
   degraded or down (`⚠ W-ARM-301` amber / `✖ E-ARM-310` red). Running machines show nothing.

## Popups (click to open, Esc / ✕ / click-outside to close, one at a time)
- **Click a machine (3D raycast or its hint chip)** → machine popover (right side,
  ~360 px wide): machine name + status chip + active codes; list of parts, each one
  row: status dot, name, its most abnormal reading (`24V rail 20.7 V`).
  **Click a part row** → it expands in place to the full detail: every signal with value,
  threshold bar (nominal→warn→fail, direction-aware) and sparkline. Caption:
  "Live sensor data — this is what Wrench-bot reads."
- **Click the agent chip** → agent popup (left side, ~420 px): step tracker, diagnosis
  (model probabilities, and the heuristic prior shown as a faint second bar labelled
  "fault-code rule"), evidence lines, catalog listings with images/probabilities,
  quote breakdown, policy verdict, retry button.
- **☰ MENU** → small dropdown: Scenarios · Manager's Desk · Chaos · Spare parts.
  Each opens its existing panel as a centred modal.
- **Scenario picker** still shows full-screen on first load.

## Rules
- No permanently visible side columns. Everything except the items in
  "Default screen" lives in a popup.
- Panels keep receiving updates while hidden (inspector history keeps accumulating).
- Keyboard: Esc closes the top popup; M toggles the menu; L toggles the log size.
- Pixel aesthetic stays (Press Start 2P titles, VT323 text, hard shadows, Nord palette).
- Must look clean at 1280×720 and 1920×1080.
