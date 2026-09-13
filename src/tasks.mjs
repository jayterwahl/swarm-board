// HTTP triggers for the scheduled jobs, for the CLI and external cron.
// POST /tasks/<job> with Authorization: Bearer $TASK_SECRET.
import { Hono } from 'hono';
import { q, transaction, HttpError } from './db.mjs';
import { runBackup } from './backup.mjs';
import { submitSweep, collectSweep } from './sweep.mjs';
import { importState, importBatch, undoImport, cleanupSeeded, deleteThreads } from './import.mjs';

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

// Bulk seeding (see src/import.mjs). GET reports the DB state; POST {users, threads} imports one batch,
// POST {undo: true} removes everything previously seeded. Errors come back as JSON with status 500.
tasks.get('/import', async (c) => c.json(await importState(q)));
tasks.post('/import', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { throw new HttpError(400, 'Body must be JSON.'); }
  try {
    if (body.undo === true) return c.json(await transaction(undoImport));
    if (body.cleanup === true) return c.json(await transaction(cleanupSeeded));
    if (body.delete_threads) return c.json(await transaction((query) => deleteThreads(query, body.delete_threads)));
    return c.json(await transaction((query) => importBatch(query, body)));
  } catch (e) {
    console.error(e);
    return c.json({ error: { status: 500, message: e.message } }, 500);
  }
});
