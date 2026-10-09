// `npm run reap:smoke -w server [machineId] [componentId] [--manual]`
// Runs the real purchase flow for one part with no game: live search → quote → checkout.
// Without REAP_ENROLLMENT_ID it stops after the quote.

import { MACHINES } from '../../shared/contract.js';
import { config } from '../src/config.js';
import { findReplacement } from '../src/catalog/catalog.js';
import { quoteParts, startCheckout, waitForCheckout } from '../src/reap/purchase.js';

const [machineId = 'sorter', componentId = 'prox-sensor'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const component = MACHINES.find((m) => m.id === machineId)?.components.find((c) => c.id === componentId);
if (!component) throw new Error(`Unknown part ${machineId}/${componentId}`);
console.log(`Part: ${component.name} (${config.mockReap ? 'MOCK' : 'LIVE'})`);

const found = await findReplacement(component, { trusted: ['Switch Electronics', 'Digitmakers.ca', 'Tech For Less'], useModel: false });
console.log(`Found ${found.offers.length} listings (${found.source}); chosen: ${found.chosen?.name} @ ${found.chosen?.merchant} $${found.chosen?.price}`);

const quote = await quoteParts([found.chosen], { express: true });
console.log('Quote:', JSON.stringify(quote, null, 2));

if (!config.reap.enrollmentId && !config.mockReap) {
  console.log('\nNo REAP_ENROLLMENT_ID — run `npm run reap:enroll -w server` first to test checkout.');
  process.exit(0);
}

const co = await startCheckout(quote, { autoApprove: !process.argv.includes('--manual') });
console.log('Checkout:', co);
if (co.approvalUrl) console.log(`\nApprove here: ${co.approvalUrl}\n`);
console.log('Result:', await waitForCheckout(co.checkoutId));
