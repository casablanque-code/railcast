CREATE TABLE sessions (
  id TEXT PRIMARY KEY,           -- случайная строка, живёт в cookie
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
