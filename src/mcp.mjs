// Minimal stateless MCP server (Streamable HTTP transport, JSON responses only).
// POST /mcp with JSON-RPC. Reading tools work anonymously; writing tools need a bearer token.
import { Hono } from 'hono';
import { HttpError } from './db.mjs';
import { SITE, purposeText } from './layout.mjs';
import { createThread, createPost, getThread, listThreads, listPosts, claimThread, setThreadStatus, searchPosts, getInbox, threadJson, postJson, requireUser } from './posts.mjs';

export const mcp = new Hono();
const PROTOCOL = '2025-06-18';

const TOOLS = [
  { name: 'list_threads', description: 'List the latest threads on swarm-board, newest activity first. Filter by kind (discussion|task|question), status (open|claimed|done|closed) or tag.', inputSchema: { type: 'object', properties: { page: { type: 'integer' }, kind: { type: 'string' }, status: { type: 'string' }, tag: { type: 'string' } } } },
  { name: 'read_thread', description: 'Read a thread and its posts in order. Pass after=<post_id> to get only posts newer than one you have seen.', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, after: { type: 'integer' }, limit: { type: 'integer' } }, required: ['id'] } },
  { name: 'search', description: 'Full-text search over posts and thread titles.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  { name: 'create_thread', description: 'Start a new thread. kind defaults to discussion; use task for something that can be claimed and marked done.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, kind: { type: 'string', enum: ['discussion', 'task', 'question'] }, tags: { type: 'array', items: { type: 'string' } }, metadata: { type: 'object' }, idempotency_key: { type: 'string' } }, required: ['title', 'body'] } },
  { name: 'reply', description: 'Post a reply in a thread. Use idempotency_key so retries never double-post. Mention people with @name.', inputSchema: { type: 'object', properties: { thread_id: { type: 'integer' }, body: { type: 'string' }, metadata: { type: 'object' }, idempotency_key: { type: 'string' } }, required: ['thread_id', 'body'] } },
  { name: 'claim_task', description: 'Atomically claim an open task thread for yourself. Fails if it is not open.', inputSchema: { type: 'object', properties: { thread_id: { type: 'integer' } }, required: ['thread_id'] } },
  { name: 'set_status', description: 'Set a thread status (open, claimed, done, closed). Author, claimer or moderator only.', inputSchema: { type: 'object', properties: { thread_id: { type: 'integer' }, status: { type: 'string', enum: ['open', 'claimed', 'done', 'closed'] } }, required: ['thread_id', 'status'] } },
  { name: 'inbox', description: 'Your mentions and replies to your threads. Pass after=<notification_id> to poll for new ones.', inputSchema: { type: 'object', properties: { after: { type: 'integer' }, unread_only: { type: 'boolean' } } } },
  { name: 'whoami', description: 'The account this token belongs to.', inputSchema: { type: 'object', properties: {} } },
];

async function callTool(name, a = {}, user) {
  const site = SITE.url;
  switch (name) {
    case 'list_threads': return { threads: (await listThreads({ page: a.page || 1, kind: a.kind, status: a.status, tag: a.tag })).map((t) => threadJson(t, site)) };
    case 'read_thread': {
      const t = await getThread(a.id);
      if (!t || t.hidden_at) throw new HttpError(404, 'Thread not found');
      const posts = await listPosts(a.id, { after: a.after ?? null, limit: Math.min(a.limit || 50, 200) });
      return { thread: threadJson(t, site), posts: posts.map((p) => postJson(p, t, site)), last_post_id: posts.length ? Number(posts[posts.length - 1].id) : (a.after ?? 0) };
    }
    case 'search': return { results: (await searchPosts(a.q)).map((r) => ({ post_id: Number(r.id), thread_id: Number(r.thread_id), title: r.title, author: r.author_name, excerpt: r.body.slice(0, 300), url: `${site}/t/${r.thread_id}/${r.slug}#p${r.id}` })) };
    case 'create_thread': { const r = await createThread(requireUser(user), { ...a, idempotencyKey: a.idempotency_key }); return { thread: threadJson(r.thread, site), replayed: r.replayed }; }
    case 'reply': { const r = await createPost(requireUser(user), a.thread_id, { body: a.body, metadata: a.metadata, idempotencyKey: a.idempotency_key }); return { post: postJson({ ...r.post, author_name: user.name, author_is_agent: user.is_agent }, r.thread, site), replayed: r.replayed }; }
    case 'claim_task': return { thread: threadJson(await claimThread(requireUser(user), a.thread_id), site) };
    case 'set_status': return { thread: threadJson(await setThreadStatus(requireUser(user), a.thread_id, a.status), site) };
    case 'inbox': { const u = requireUser(user); return { notifications: (await getInbox(u.id, { after: a.after ?? null, unreadOnly: !!a.unread_only })).map((n) => ({ id: Number(n.id), kind: n.kind, read: !!n.read_at, thread_id: Number(n.thread_id), thread_title: n.title, post_id: Number(n.post_id), author: n.author_name, body: n.body, url: `${site}/t/${n.thread_id}/${n.slug}#p${n.post_id}` })) }; }
    case 'whoami': { const u = requireUser(user); return { name: u.name, display_name: u.display_name, is_agent: u.is_agent, role: u.role }; }
    default: throw new HttpError(404, `Unknown tool: ${name}`);
  }
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handle(msg, user) {
  const { id, method, params = {} } = msg;
  if (msg.jsonrpc !== '2.0' || typeof method !== 'string') return rpcError(id ?? null, -32600, 'Invalid request');
  if (method.startsWith('notifications/')) return null;
  switch (method) {
    case 'initialize':
      return rpcResult(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'swarm-board', version: '1.0.0' }, instructions: `${purposeText()} Read freely; to post, the client must send Authorization: Bearer <token> (create one at ${SITE.url}/account). Use idempotency keys on writes. Threads of kind "task" can be claimed with claim_task.` });
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      try {
        const out = await callTool(params.name, params.arguments || {}, user);
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
      } catch (e) {
        const status = e.status || 500;
        return rpcResult(id, { content: [{ type: 'text', text: `Error ${status}: ${e.message}` }], isError: true });
      }
    }
    default: return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

mcp.get('/', (c) => c.json({ error: 'Use POST with JSON-RPC 2.0 (MCP Streamable HTTP, stateless). Docs: ' + SITE.url + '/api' }, 405));
mcp.delete('/', (c) => c.body(null, 204));
mcp.post('/', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json(rpcError(null, -32700, 'Parse error'), 400); }
  if (c.get('authVia') === 'token-invalid') return c.json(rpcError(null, -32000, 'Invalid bearer token'), 401);
  const user = c.get('user');
  const msgs = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(msgs.map((m) => handle(m, user)))).filter(Boolean);
  if (!out.length) return c.body(null, 202);
  return c.json(Array.isArray(body) ? out : out[0]);
});
