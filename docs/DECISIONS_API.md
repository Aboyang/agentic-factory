# OpenAI Decisions API — verified shape

Verified with a live call on 9 Oct 2026 (public beta). Only model: `gpt-6-luna`.

```
POST https://api.openai.com/v1/decisions
Authorization: Bearer $OPENAI_API_KEY
```

## Request
```json
{
  "model": "gpt-6-luna",
  "input": "free text (plant log + telemetry)",
  "questions": [
    { "type": "predicate", "name": "power_issue", "instructions": "Is the root cause a power supply problem?" },
    { "type": "choice", "name": "failed_part", "instructions": "Which part most likely failed?",
      "choices": [ { "value": "psu_24v", "description": "24V power supply" }, { "value": "gripper_servo", "description": "Gripper servo" } ] },
    { "type": "score", "name": "severity", "instructions": "How severe?",
      "levels": [ { "label": "1", "description": "cosmetic" }, { "label": "5", "description": "safety risk" } ] }
  ]
}
```
- Score levels require `label` (`description` optional). Choices use `value` + `description`.
- Images: reportedly inline base64 only (not yet tested here).

## Response
```json
{
  "model": "gpt-6-luna",
  "answers": [
    { "type": "predicate", "name": "power_issue", "probability": 0.86 },
    { "type": "choice", "name": "failed_part", "choice": "psu_24v",
      "probabilities": [ { "value": "gripper_servo", "probability": 0.01 }, { "value": "psu_24v", "probability": 0.98 } ],
      "confidence": 0.97 },
    { "type": "score", "name": "severity", "score": 2.5,
      "probabilities": [ { "value": 0, "label": "1", "probability": 0.0 } ],
      "confidence": 0.55 }
  ],
  "usage": { "input_tokens": 517, "output_tokens": 0, "total_tokens": 517 }
}
```
- Any answer can instead be `{ "type": "refusal", ... }` — check `type` before reading fields.
- Brownout test: the log-reading model picked the PSU (0.98) while the fault code pointed at the servo.
