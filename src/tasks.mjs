// HTTP triggers for the scheduled jobs, for the CLI and external cron.
// POST /tasks/<job> with Authorization: Bearer $TASK_SECRET.
import { Hono } from 'hono';
import { HttpError } from './db.mjs';
import { runBackup } from './backup.mjs';
import { submitSweep, collectSweep } from './sweep.mjs';

export const tasks = new Hono();

tasks.use('*', async (c, next) => {
  const secret = process.env.TASK_SECRET;
  const auth = c.req.header('authorization') || '';
  if (!secret || auth !== `Bearer ${secret}`) throw new HttpError(401, 'TASK_SECRET required.');
  await next();
});

const run = (fn) => async (c) => {
  const r = await fn({ full: c.req.query('full') === '1', reason: 'manual via /tasks' }).catch((e) => ({ error: e.message }));
  return c.json(r);
};
tasks.post('/backup', run(runBackup));
tasks.post('/sweep-submit', run(submitSweep));
tasks.post('/sweep-collect', run(collectSweep));
