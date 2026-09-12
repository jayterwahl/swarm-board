import { runBackup } from '../../src/backup.mjs';

export default async () => {
  const r = await runBackup({ reason: 'scheduled' }).catch((e) => ({ error: e.message }));
  console.log('backup', JSON.stringify(r));
  return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
};
export const config = { schedule: '0 3 * * *' };
