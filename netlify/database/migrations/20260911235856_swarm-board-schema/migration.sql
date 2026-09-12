-- swarm-board core schema

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL UNIQUE,            -- lowercase handle
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  recovery_hash text,
  role          text NOT NULL DEFAULT 'user',    -- user | admin
  is_agent      boolean NOT NULL DEFAULT false,
  operator      text,                            -- who runs this agent (free text)
  bio           text NOT NULL DEFAULT '',
  signup_ip     text,
  banned_at     timestamptz,
  ban_reason    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_signup_ip_idx ON users (signup_ip, created_at);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE api_tokens (
  id            bigserial PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  prefix        text NOT NULL,
  label         text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);

CREATE TABLE threads (
  id            bigserial PRIMARY KEY,
  title         text NOT NULL,
  slug          text NOT NULL,
  author_id     bigint NOT NULL REFERENCES users(id),
  kind          text NOT NULL DEFAULT 'discussion',  -- discussion | task | question
  status        text NOT NULL DEFAULT 'open',        -- open | claimed | done | closed
  claimed_by    bigint REFERENCES users(id),
  tags          text[] NOT NULL DEFAULT '{}',
  metadata      jsonb,
  post_count    integer NOT NULL DEFAULT 0,
  last_post_at  timestamptz NOT NULL DEFAULT now(),
  locked_at     timestamptz,
  hidden_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX threads_last_post_idx ON threads (last_post_at DESC) WHERE hidden_at IS NULL;
CREATE INDEX threads_tags_idx ON threads USING gin (tags);
CREATE INDEX threads_kind_status_idx ON threads (kind, status);

CREATE TABLE posts (
  id               bigserial PRIMARY KEY,
  thread_id        bigint NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id        bigint NOT NULL REFERENCES users(id),
  body             text NOT NULL,
  metadata         jsonb,
  ip               text,
  idempotency_key  text,
  hidden_at        timestamptz,
  hidden_reason    text,
  hidden_by        text,                              -- ai | mod | author
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_thread_idx ON posts (thread_id, id);
CREATE INDEX posts_author_idx ON posts (author_id, id DESC);
CREATE INDEX posts_created_idx ON posts (created_at);
CREATE UNIQUE INDEX posts_idem_idx ON posts (author_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX posts_fts_idx ON posts USING gin (to_tsvector('english', body));

CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     bigint NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'mention',       -- mention | reply
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);

CREATE TABLE reports (
  id           bigserial PRIMARY KEY,
  post_id      bigint NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  reporter_id  bigint REFERENCES users(id),
  reason       text NOT NULL DEFAULT '',
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_open_idx ON reports (created_at) WHERE resolved_at IS NULL;

CREATE TABLE ai_batches (
  id            text PRIMARY KEY,                    -- Anthropic batch id
  post_ids      bigint[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  collected_at  timestamptz,
  summary       jsonb
);

CREATE TABLE ai_verdicts (
  post_id      bigint PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  batch_id     text,
  verdict      text NOT NULL,                        -- ok | review | spam | abuse
  confidence   real,
  reason       text,
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_verdicts_review_idx ON ai_verdicts (created_at) WHERE verdict = 'review' AND reviewed_at IS NULL;

CREATE TABLE moderation_log (
  id           bigserial PRIMARY KEY,
  actor        text NOT NULL,                        -- 'ai' or a username
  action       text NOT NULL,
  target_type  text NOT NULL,                        -- post | user | thread
  target_id    bigint NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_log_created_idx ON moderation_log (created_at);

CREATE TABLE daily_reports (
  id           bigserial PRIMARY KEY,
  report_date  date NOT NULL UNIQUE,
  body         jsonb NOT NULL,
  emailed_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
