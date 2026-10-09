// Creates a card enrollment, prints the hosted card-entry link, then waits until
// it is ACTIVE and prints the ID to put in .env as REAP_ENROLLMENT_ID.
//
// Enter the team's test card YOURSELF on Reap's page (never paste it into code
// or an AI chat). If asked for a one-time password, the docs say use 456789.

import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';

const headers = {
  Authorization: `Bearer ${config.reap.apiKey}`,
  'Reap-Version': config.reap.version,
  'Content-Type': 'application/json',
};

const res = await fetch(`${config.reap.baseUrl}/agentic/enrollments`, {
  method: 'POST',
  headers: { ...headers, 'Idempotency-Key': randomUUID() },
  body: JSON.stringify({
    source: 'EXTERNAL',
    owner: { type: 'CLIENT_REFERENCE', id: 'factory-manager-1', email: config.buyerEmail },
    // Reap wants an HTTPS return URL; this page is just where you land afterwards.
    presentation: { type: 'REDIRECT', returnUrl: process.env.ENROLL_RETURN_URL || 'https://example.com/enrolled' },
  }),
});
const enr = await res.json();
if (!res.ok) {
  console.error('Enrollment failed:', JSON.stringify(enr, null, 2));
  process.exit(1);
}

console.log(`\nEnrollment ${enr.id} (${enr.status})`);
if (enr.nextAction?.url) console.log(`\nOpen this link and enter the test card:\n\n  ${enr.nextAction.url}\n`);

for (let i = 0; i < 120; i++) {
  const r = await fetch(`${config.reap.baseUrl}/agentic/enrollments/${enr.id}`, { headers });
  const cur = await r.json();
  if (cur.status === 'ACTIVE') {
    console.log(`✅ ACTIVE — card ${cur.paymentMethod?.network} •••• ${cur.paymentMethod?.last4}`);
    console.log(`\nAdd this line to .env:\n\n  REAP_ENROLLMENT_ID=${enr.id}\n`);
    process.exit(0);
  }
  if (['FAILED', 'EXPIRED', 'REVOKED'].includes(cur.status)) {
    console.error(`Enrollment ended with status ${cur.status}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.error('Timed out waiting for ACTIVE');
