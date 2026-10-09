import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const env = process.env;

export const config = {
  port: Number(env.PORT || 8787),
  // Where the browser comes back to after Reap's hosted pages. Reap only accepts
  // public HTTPS URLs (localhost is rejected); the game polls the checkout
  // status itself, so this is just where the approval tab lands.
  publicUrl: env.PUBLIC_URL || 'http://localhost:5173',
  returnUrl: env.REAP_RETURN_URL || 'https://example.com/wrench-bot/approved',

  reap: {
    baseUrl: env.REAP_BASE_URL || 'https://sandbox.api.reap.global',
    apiKey: env.REAP_API_KEY,
    version: env.REAP_VERSION || '2025-02-14',
    enrollmentId: env.REAP_ENROLLMENT_ID, // set after running `npm run reap:enroll`
  },

  openai: {
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL || 'gpt-5-mini',
  },

  jev: {
    apiKey: env.JEV_API_KEY,
  },

  // Mock switches let the game team work without keys or network.
  mockReap: env.MOCK_REAP === '1' || !env.REAP_API_KEY,
  mockAi: env.MOCK_AI === '1' || !env.OPENAI_API_KEY,

  // Judge mode (public demo): live AI, live Reap search and quotes, but the Reap
  // checkout is simulated (visitors can't tap our passkey), onchain payouts are
  // tiny and capped, and an idle factory resets itself to the first scenario.
  judge: env.JUDGE_MODE === '1',

  // Game-time compression: real shipping days become seconds.
  timing: {
    deliverySeconds: Number(env.DELIVERY_SECONDS || 8),
    expressDeliverySeconds: Number(env.EXPRESS_DELIVERY_SECONDS || 4),
    repairSeconds: Number(env.REPAIR_SECONDS || 6),
  },

  // Demo address for quotes (US quotes were verified to work).
  shippingAddress: {
    firstName: 'Wrench',
    lastName: 'Bot',
    phone: '+14155550123',
    addressLine1: '1 Market St',
    city: 'San Francisco',
    region: 'CA',
    postalCode: '94105',
    country: 'US',
  },
  buyerEmail: env.BUYER_EMAIL || 'factory@example.com',
};
