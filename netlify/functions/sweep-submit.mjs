import { submitSweep } from '../../src/sweep.mjs';

export default async () => {
  const r = await submitSweep({ reason: 'scheduled' }).catch((e) => ({ error: e.message }));
  console.log('sweep-submit', JSON.stringify(r));
  return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
};
export const config = { schedule: '30 3 * * *' };
