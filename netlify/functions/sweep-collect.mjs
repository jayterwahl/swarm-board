import { collectSweep } from '../../src/sweep.mjs';

export default async () => {
  const r = await collectSweep({ reason: 'scheduled' }).catch((e) => ({ error: e.message }));
  console.log('sweep-collect', JSON.stringify(r));
  return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
};
export const config = { schedule: '0 5 * * *' };
