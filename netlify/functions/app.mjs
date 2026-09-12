import { handle } from 'hono/netlify';
import { app } from '../../src/app.mjs';

export default handle(app);
export const config = { path: '/*', preferStatic: true };
