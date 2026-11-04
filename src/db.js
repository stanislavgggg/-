const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      src TEXT,
      variant TEXT,
      created_at INTEGER,
      streak INTEGER DEFAULT 0,
      best_streak INTEGER DEFAULT 0,
      score_user INTEGER DEFAULT 0,
      score_ai INTEGER DEFAULT 0,
      graded_count INTEGER DEFAULT 0,
      invites INTEGER DEFAULT 0,
      invited_at INTEGER,
      joined_at INTEGER,
      join_via TEXT,
      left_at INTEGER,
      blocked INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS picks (
      user_id INTEGER NOT NULL,
      match_id TEXT NOT NULL,
      pick TEXT NOT NULL,
      ai_pick TEXT,
      created_at INTEGER NOT NULL,
      graded INTEGER DEFAULT 0,
      correct INTEGER,
      ai_correct INTEGER,
      PRIMARY KEY (user_id, match_id)
    );
    CREATE TABLE IF NOT EXISTS invite_links (
      src TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS joins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      link_name TEXT,
      src TEXT,
      known_user INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS results (
      match_id TEXT PRIMARY KEY,
      score TEXT NOT NULL,
      set_by INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      run_at INTEGER NOT NULL,
      payload TEXT,
      attempts INTEGER DEFAULT 0,
      done INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS jobs_due ON jobs(done, run_at);
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_once ON jobs(user_id, kind, payload);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT NOT NULL,
      meta TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  const now = () => Date.now();

  const api = {
    raw: db,
    getUser: (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),

    upsertUser({ id, username, first_name, src, variant }) {
      const existing = api.getUser(id);
      if (existing) {
        db.prepare('UPDATE users SET username = ?, first_name = ?, blocked = 0 WHERE id = ?').run(username || null, first_name || null, id);
        return { user: api.getUser(id), isNew: false };
      }
      db.prepare('INSERT INTO users (id, username, first_name, src, variant, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, username || null, first_name || null, src || 'organic', variant, now());
      return { user: api.getUser(id), isNew: true };
    },

    setUser(id, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return;
      db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    },

    // picks
    getPick: (u, m) => db.prepare('SELECT * FROM picks WHERE user_id = ? AND match_id = ?').get(u, String(m)),
    addPick: ({ userId, matchId, pick, aiPick }) =>
      db.prepare('INSERT OR IGNORE INTO picks (user_id, match_id, pick, ai_pick, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, String(matchId), pick, aiPick, now()).changes === 1,
    pickedIds: (u) => db.prepare('SELECT match_id FROM picks WHERE user_id = ?').all(u).map((r) => r.match_id),
    pickCount: (u) => db.prepare('SELECT COUNT(*) c FROM picks WHERE user_id = ?').get(u).c,
    gradePick: (u, m, c, a) =>
      db.prepare('UPDATE picks SET graded = 1, correct = ?, ai_correct = ? WHERE user_id = ? AND match_id = ?').run(Number(c), Number(a), u, String(m)),

    weeklyTop(sinceMs, limit = 10) {
      return db.prepare(`
        SELECT u.id, u.first_name, u.username, SUM(p.correct = 1) AS wins, COUNT(*) AS graded, MIN(p.created_at) AS first_at
        FROM picks p JOIN users u ON u.id = p.user_id
        WHERE p.graded = 1 AND p.created_at >= ?
        GROUP BY u.id HAVING wins > 0
        ORDER BY wins DESC, graded ASC, first_at ASC LIMIT ?`).all(sinceMs, limit);
    },
    weeklyRank(userId, sinceMs) {
      const rows = api.weeklyTop(sinceMs, 100000);
      const i = rows.findIndex((r) => r.id === userId);
      return i === -1 ? null : { rank: i + 1, of: rows.length, wins: rows[i].wins };
    },

    // invite links per source
    getInvite: (src) => db.prepare('SELECT * FROM invite_links WHERE src = ?').get(src),
    saveInvite: (src, url, name) =>
      db.prepare('INSERT OR REPLACE INTO invite_links (src, url, name, created_at) VALUES (?, ?, ?, ?)').run(src, url, name, now()),
    srcByLinkName: (name) => (db.prepare('SELECT src FROM invite_links WHERE name = ?').get(name) || {}).src || null,
    logJoin: (userId, linkName, src, known) =>
      db.prepare('INSERT INTO joins (user_id, link_name, src, known_user, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, linkName || null, src || null, known ? 1 : 0, now()),

    // admin result overrides
    setResult: (matchId, score, by) =>
      db.prepare('INSERT OR REPLACE INTO results (match_id, score, set_by, created_at) VALUES (?, ?, ?, ?)').run(String(matchId), score, by || null, now()),
    getResult: (matchId) => db.prepare('SELECT * FROM results WHERE match_id = ?').get(String(matchId)) || null,

    // events / jobs
    logEvent: (userId, type, meta) =>
      db.prepare('INSERT INTO events (user_id, type, meta, created_at) VALUES (?, ?, ?, ?)').run(userId || null, type, meta ? JSON.stringify(meta) : null, now()),
    schedule: (userId, kind, runAt, payload = '') =>
      db.prepare('INSERT OR IGNORE INTO jobs (user_id, kind, run_at, payload) VALUES (?, ?, ?, ?)').run(userId, kind, runAt, String(payload)),
    dueJobs: (limit = 200) => db.prepare('SELECT * FROM jobs WHERE done = 0 AND run_at <= ? ORDER BY run_at LIMIT ?').all(now(), limit),
    finishJob: (id) => db.prepare('UPDATE jobs SET done = 1 WHERE id = ?').run(id),
    retryJob: (id, runAt) => db.prepare('UPDATE jobs SET run_at = ?, attempts = attempts + 1 WHERE id = ?').run(runAt, id),
    cancelJobs(userId, kinds) {
      const q = kinds
        ? `UPDATE jobs SET done = 1 WHERE user_id = ? AND done = 0 AND kind IN (${kinds.map(() => '?').join(',')})`
        : 'UPDATE jobs SET done = 1 WHERE user_id = ? AND done = 0';
      db.prepare(q).run(userId, ...(kinds || []));
    },
    usersInvitedNotJoined: (sinceMs) =>
      db.prepare('SELECT id FROM users WHERE invited_at IS NOT NULL AND joined_at IS NULL AND blocked = 0 AND invited_at >= ?').all(sinceMs).map((r) => r.id),

    stats() {
      return db.prepare(`
        SELECT u.src, u.variant,
          COUNT(*) AS starts,
          SUM((SELECT COUNT(*) FROM picks p WHERE p.user_id = u.id) > 0) AS pickers,
          SUM(u.invited_at IS NOT NULL) AS invited,
          SUM(u.joined_at IS NOT NULL) AS joined,
          SUM(u.left_at IS NOT NULL) AS left_group,
          SUM(u.blocked) AS blocked
        FROM users u GROUP BY u.src, u.variant ORDER BY starts DESC`).all();
    },
    // All joins through bot links by source, including people who joined via a forwarded link without using the bot.
    joinStats: () =>
      db.prepare('SELECT src, COUNT(*) AS joins, SUM(known_user) AS from_bot_users FROM joins GROUP BY src ORDER BY joins DESC').all(),
  };
  return api;
}

module.exports = { openDb };
