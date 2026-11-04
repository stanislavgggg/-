// "Tu pret MI" funnel for Latvia (GG Group). Goal: join the Lucky Latvia group,
// attributed to the ad source via per-source invite links.
//
// tg = {
//   send(userId, html, extra),
//   createInviteLink(name) -> Promise<url>,     // bot must be a group admin with invite rights
//   memberStatus(userId) -> Promise<string|null> // 'member' | 'administrator' | 'creator' | 'left' | ...
// }

const textsLib = require('./texts');
const kbLib = require('./keyboards');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LOCK_BEFORE = 5 * MIN;
const SLATE_HORIZON = 48 * HOUR;
const SLATE_SIZE = 5;
const DAILY_DAYS = 14;
const MAX_INVITES = 3;
const GRADE_AFTER = 165 * MIN; // hockey incl. overtime / shootout ≈ 2.5–2.75 h
const MEMBER = new Set(['member', 'administrator', 'creator', 'restricted']);

// A/B: when to invite to the group. A = right after the first pick; B = after the first graded result.
const variantFor = (id) => (Number(id) % 2 === 0 ? 'A' : 'B');
const parseSource = (p) => (/^[A-Za-z0-9_-]{1,64}$/.test(String(p || '').trim()) ? String(p).trim() : 'organic');
const linkNameFor = (src) => `b_${src}`.slice(0, 32);

function weekStart(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

function createFunnel({ db, api, config, tg, now = () => Date.now() }) {
  const T = textsLib.create(config);
  const kb = kbLib.create(T);

  async function send(userId, html, extra = {}) {
    try {
      await tg.send(userId, html, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
      return true;
    } catch (e) {
      if ((e?.response?.error_code || e?.code) === 403) {
        db.setUser(userId, { blocked: 1 });
        db.cancelJobs(userId);
        db.logEvent(userId, 'blocked');
        return false;
      }
      throw e;
    }
  }

  const ensureUser = (from) => db.getUser(from.id)
    || db.upsertUser({ id: from.id, username: from.username, first_name: from.first_name, src: 'organic', variant: variantFor(from.id) }).user;

  async function slate() {
    const t = now();
    return (await api.all())
      .filter((m) => api.isUsable(m) && !m.result && m.startsAt - LOCK_BEFORE > t && m.startsAt < t + SLATE_HORIZON)
      .sort((a, b) => a.startsAt - b.startsAt)
      .slice(0, SLATE_SIZE);
  }

  async function openFor(userId) {
    const picked = new Set(db.pickedIds(userId));
    const list = await slate();
    return { list, open: list.filter((m) => !picked.has(m.id)) };
  }

  async function askNext(userId) {
    const { list, open } = await openFor(userId);
    if (!list.length) return send(userId, T.noSlate(), kb.menu());
    if (!open.length) return send(userId, T.allPicked(), kb.menu());
    const m = open[0];
    return send(userId, T.question(m, list.indexOf(m), list.length), kb.question(m));
  }

  // One invite link per ad source, created once and reused; joins through it are attributed to that source.
  async function inviteUrlFor(src) {
    const cached = db.getInvite(src);
    if (cached) return cached.url;
    if (config.groupChatId) {
      try {
        const name = linkNameFor(src);
        const url = await tg.createInviteLink(name);
        db.saveInvite(src, url, name);
        return url;
      } catch (e) {
        console.error('[invite] create failed:', e.message);
        db.logEvent(null, 'invite_link_failed', { src, error: e.message });
      }
    }
    return config.groupFallbackUrl || null;
  }

  async function invite(userId, reason) {
    const u = db.getUser(userId);
    if (!u || u.joined_at || u.invites >= MAX_INVITES) return false;
    const url = await inviteUrlFor(u.src);
    if (!url) return false;
    db.setUser(userId, { invites: u.invites + 1, invited_at: u.invited_at || now() });
    db.logEvent(userId, 'invite', { reason, n: u.invites + 1 });
    const ok = await send(userId, T.invite(), kb.join(url));
    if (ok) {
      db.schedule(userId, 'check_join', now() + 15 * MIN, `c${u.invites + 1}a`);
      db.schedule(userId, 'check_join', now() + DAY, `c${u.invites + 1}b`);
    }
    return ok;
  }

  async function markJoined(userId, via) {
    const u = db.getUser(userId);
    if (!u || u.joined_at) return false;
    db.setUser(userId, { joined_at: now(), join_via: via, left_at: null });
    db.cancelJobs(userId, ['invite', 'check_join']);
    db.logEvent(userId, 'joined', { via });
    await send(userId, T.joined(), kb.slate());
    return true;
  }

  return {
    T,
    variantFor,
    parseSource,
    linkNameFor,

    async onStart(from, payload) {
      const src = parseSource(payload);
      const { user, isNew } = db.upsertUser({
        id: from.id, username: from.username, first_name: from.first_name, src, variant: variantFor(from.id),
      });
      db.logEvent(user.id, isNew ? 'start' : 'restart', { src });
      if (isNew) {
        const t0 = now();
        for (let d = 1; d <= DAILY_DAYS; d++) db.schedule(user.id, 'daily', t0 + d * DAY, `d${d}`);
        db.schedule(user.id, 'invite', t0 + 26 * HOUR, '1');
        db.schedule(user.id, 'invite', t0 + 72 * HOUR, '2');
      }
      await send(user.id, T.intro());
      return askNext(user.id);
    },

    onSlate: (from) => askNext(ensureUser(from).id),

    async onPick(from, matchId, pick) {
      const user = ensureUser(from);
      const m = await api.byId(matchId);
      if (!m || !['home', 'away'].includes(pick) || !api.isUsable(m)) return askNext(user.id);
      if (m.startsAt - LOCK_BEFORE <= now() || m.result) return send(user.id, T.locked(), kb.slate());
      if (!db.addPick({ userId: user.id, matchId: m.id, pick, aiPick: m.consensus })) {
        return send(user.id, T.already(m, db.getPick(user.id, m.id)), kb.slate());
      }
      db.logEvent(user.id, 'pick', { match: m.id, agree: pick === m.consensus });
      db.schedule(user.id, 'grade', m.startsAt + GRADE_AFTER, m.id);
      const { open } = await openFor(user.id);
      await send(user.id, T.reveal(m, pick), kb.afterPick(open.length > 0));
      if (user.variant === 'A' && db.pickCount(user.id) === 1) await invite(user.id, 'first_pick');
    },

    async onTop(from) {
      const user = ensureUser(from);
      const since = weekStart(now());
      return send(user.id, T.top(db.weeklyTop(since), db.weeklyRank(user.id, since)), kb.slate());
    },

    async onMe(from) {
      const user = ensureUser(from);
      return send(user.id, T.me(db.getUser(user.id), db.pickCount(user.id)), kb.menu());
    },

    // Telegram chat_member update in the group.
    async onChatMember(upd) {
      if (!upd || String(upd.chat?.id) !== String(config.groupChatId)) return;
      const userId = upd.new_chat_member?.user?.id;
      const was = upd.old_chat_member?.status;
      const is = upd.new_chat_member?.status;
      if (!userId) return;
      const joinedNow = MEMBER.has(is) && !MEMBER.has(was);
      const leftNow = !MEMBER.has(is) && MEMBER.has(was);
      if (joinedNow) {
        const name = upd.invite_link?.name || null;
        const src = name ? db.srcByLinkName(name) : null;
        const known = Boolean(db.getUser(userId));
        if (src || known) db.logJoin(userId, name, src, known); // only joins we can attribute or that came from the bot
        if (known) await markJoined(userId, name || 'other');
      } else if (leftNow && db.getUser(userId)) {
        db.setUser(userId, { left_at: now() });
        db.logEvent(userId, 'left_group');
      }
    },

    // Admin: set a final score when the source has no results. Returns graded match or null.
    async setResult(matchId, score, adminId) {
      const m = await api.byId(matchId);
      if (!m) return { ok: false, reason: 'unknown match' };
      if (!/^\s*\d+\s*[:\-–]\s*\d+\s*$/.test(score) || /^\s*(\d+)\s*[:\-–]\s*\1\s*$/.test(score)) {
        return { ok: false, reason: 'score must be the final incl. OT/shootout, like 3:2 (no draws)' };
      }
      db.setResult(m.id, score.replace(/\s/g, '').replace(/[-–]/, ':'), adminId);
      return { ok: true, match: await api.byId(m.id) };
    },

    async upcomingForAdmin() {
      const items = await api.all();
      const t = now();
      return items
        .filter((m) => m.startsAt > t - 6 * HOUR && m.startsAt < t + 7 * DAY)
        .sort((a, b) => a.startsAt - b.startsAt)
        .map((m) => ({ id: m.id, title: `${m.home} – ${m.away}`, competition: m.competition, startsAt: m.startsAt,
          usable: api.isUsable(m), result: m.result ? m.result.score : null }));
    },

    async runJob(job) {
      const user = db.getUser(job.user_id);
      if (!user || user.blocked) return 'skip';

      if (job.kind === 'grade') {
        const m = await api.byId(job.payload);
        const p = db.getPick(user.id, job.payload);
        if (!m || !p || p.graded) return 'skip';
        if (!m.result) return job.attempts < 16 ? 'retry:30' : 'skip'; // wait up to ~8 h (admin may enter it)
        const correct = p.pick === m.result.outcome;
        const aiCorrect = p.ai_pick === m.result.outcome;
        db.gradePick(user.id, m.id, correct, aiCorrect);
        const streak = correct ? user.streak + 1 : 0;
        db.setUser(user.id, {
          streak, best_streak: Math.max(user.best_streak, streak),
          score_user: user.score_user + (correct ? 1 : 0), score_ai: user.score_ai + (aiCorrect ? 1 : 0),
          graded_count: user.graded_count + 1,
        });
        const u = db.getUser(user.id);
        await send(user.id, T.graded(m, db.getPick(user.id, m.id), u, db.weeklyRank(user.id, weekStart(now()))), kb.graded());
        if (u.variant === 'B' && u.graded_count === 1) await invite(user.id, 'first_result');
        return 'sent';
      }

      if (job.kind === 'daily') {
        const { open } = await openFor(user.id);
        if (!open.length) return 'skip';
        await send(user.id, T.daily(open.length), kb.slate());
        return 'sent';
      }

      if (job.kind === 'invite') {
        if (user.joined_at || db.pickCount(user.id) === 0) return 'skip'; // only engaged players
        return (await invite(user.id, `late_${job.payload}`)) ? 'sent' : 'skip';
      }

      if (job.kind === 'check_join') {
        if (user.joined_at) return 'skip';
        const st = await tg.memberStatus(user.id).catch(() => null);
        if (st && MEMBER.has(st)) {
          db.logJoin(user.id, null, user.src, true);
          await markJoined(user.id, 'check');
          return 'sent';
        }
        return 'skip';
      }
      return 'skip';
    },

    async tick() {
      const out = [];
      for (const job of db.dueJobs()) {
        let res;
        try {
          res = await this.runJob(job);
        } catch (e) {
          console.error(`[job ${job.id} ${job.kind}]`, e.message);
          res = job.attempts < 5 ? 'retry:10' : 'skip';
        }
        if (typeof res === 'string' && res.startsWith('retry:')) db.retryJob(job.id, now() + Number(res.split(':')[1]) * MIN);
        else {
          db.finishJob(job.id);
          if (res === 'sent') db.logEvent(job.user_id, `push_${job.kind}`);
        }
        out.push({ id: job.id, kind: job.kind, res });
      }
      return out;
    },
  };
}

module.exports = { createFunnel, variantFor, parseSource, linkNameFor, weekStart };
