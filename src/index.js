const express = require('express');
const { Telegraf } = require('telegraf');
const config = require('./config');
const { openDb } = require('./db');
const { createApi } = require('./api');
const { createFunnel } = require('./funnel');

if (!config.botToken) {
  console.error('BOT_TOKEN is not set');
  process.exit(1);
}

const db = openDb(config.dbPath);
const api = createApi(config, { getOverride: (id) => db.getResult(id) });
const bot = new Telegraf(config.botToken);

const tg = {
  send: (userId, html, extra) => bot.telegram.sendMessage(userId, html, extra),
  async createInviteLink(name) {
    const link = await bot.telegram.createChatInviteLink(config.groupChatId, { name });
    return link.invite_link;
  },
  async memberStatus(userId) {
    if (!config.groupChatId) return null;
    const m = await bot.telegram.getChatMember(config.groupChatId, userId);
    return m.status;
  },
};
const funnel = createFunnel({ db, api, config, tg });

const isAdmin = (ctx) => config.adminIds.includes(ctx.from?.id);
const safe = (fn) => async (ctx) => {
  try {
    await fn(ctx);
  } catch (e) {
    console.error('[handler]', e);
  } finally {
    if (ctx.callbackQuery) ctx.answerCbQuery().catch(() => {});
  }
};
const privateOnly = (fn) => (ctx) => (ctx.chat?.type === 'private' ? fn(ctx) : undefined);

bot.start(privateOnly(safe((ctx) => funnel.onStart(ctx.from, ctx.startPayload))));
bot.action('slate', safe((ctx) => funnel.onSlate(ctx.from)));
bot.action(/^pick:(.{1,40}):(home|away)$/, safe((ctx) => funnel.onPick(ctx.from, ctx.match[1], ctx.match[2])));
bot.action('top', safe((ctx) => funnel.onTop(ctx.from)));
bot.action('me', safe((ctx) => funnel.onMe(ctx.from)));
bot.command(['speles', 'picks'], privateOnly(safe((ctx) => funnel.onSlate(ctx.from))));
bot.command('top', privateOnly(safe((ctx) => funnel.onTop(ctx.from))));
bot.command(['as', 'me'], privateOnly(safe((ctx) => funnel.onMe(ctx.from))));

// Group membership updates (needs the bot as group admin + "chat_member" in allowed updates)
bot.on('chat_member', safe((ctx) => funnel.onChatMember(ctx.chatMember)));

// ---- Admin ----
const fmt = (ms) => new Date(ms).toLocaleString('lv-LV', { timeZone: config.timeZone, dateStyle: 'short', timeStyle: 'short' });

bot.command('matches', privateOnly(safe(async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await funnel.upcomingForAdmin();
  if (!rows.length) return ctx.reply('No matches in the source for the next 7 days.');
  return ctx.reply(rows.map((r) =>
    `${r.id} · ${r.title} · ${r.competition} · ${fmt(r.startsAt)}${r.result ? ` · result ${r.result}` : ''}${r.usable ? '' : ' · hidden (no consensus / league filter)'}`,
  ).join('\n'));
})));

// /result hk-001 3:2
bot.command('result', privateOnly(safe(async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [, id, score] = ctx.message.text.trim().split(/\s+/);
  if (!id || !score) return ctx.reply('Usage: /result <match_id> <home>:<away>, e.g. /result hk-001 3:2 (final incl. OT/shootout)');
  const r = await funnel.setResult(id, score, ctx.from.id);
  return ctx.reply(r.ok ? `Saved: ${r.match.home} ${r.match.result.score} ${r.match.away}. Picks are graded on the next tick.` : `Not saved: ${r.reason}`);
})));

bot.command('reload', privateOnly(safe(async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    const items = await api.reload();
    return ctx.reply(`Reloaded: ${items.length} matches, ${items.filter(api.isUsable).length} playable.`);
  } catch (e) {
    return ctx.reply(`Reload failed, previous data kept: ${e.message}`);
  }
})));

bot.command('stats', privateOnly(safe(async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = db.stats().map((r) =>
    `${r.src} [${r.variant}]: start ${r.starts} · picked ${r.pickers} · invited ${r.invited} · joined ${r.joined} · left ${r.left_group} · blocked ${r.blocked}`);
  const joins = db.joinStats().map((j) => `${j.src || '(no source)'}: ${j.joins} joins (${j.from_bot_users} bot users)`);
  return ctx.reply([...(rows.length ? rows : ['No users yet.']), '', 'Group joins by source:', ...(joins.length ? joins : ['—'])].join('\n'));
})));

// Any other private text → open matches
bot.on('text', privateOnly(safe((ctx) => funnel.onSlate(ctx.from))));

// Health check for Railway
const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(config.port, () => console.log(`[http] listening on :${config.port}`));

// Scheduler
let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    const done = await funnel.tick();
    if (done.length) console.log(`[tick] ${done.length} jobs`, done.map((d) => `${d.kind}:${d.res}`).join(' '));
  } catch (e) {
    console.error('[tick]', e);
  } finally {
    ticking = false;
  }
}, config.tickSeconds * 1000);

bot.launch({ dropPendingUpdates: true, allowedUpdates: ['message', 'callback_query', 'chat_member', 'my_chat_member'] })
  .catch((e) => {
    console.error('[bot] launch failed', e);
    process.exit(1);
  });

// Startup check: can the bot see the group and create invite links?
(async () => {
  if (!config.groupChatId) {
    console.warn('[group] GROUP_CHAT_ID is empty — invites use GROUP_FALLBACK_URL and joins are not tracked');
    return;
  }
  try {
    const me = await bot.telegram.getMe();
    const m = await bot.telegram.getChatMember(config.groupChatId, me.id);
    if (m.status !== 'administrator' || m.can_invite_users === false) {
      console.warn(`[group] bot status in group: ${m.status}; it must be an admin with "Invite users via link" to track joins`);
    } else {
      console.log('[group] bot is admin, join tracking on');
    }
  } catch (e) {
    console.warn('[group] cannot read the group:', e.message);
  }
})();
console.log('[bot] started');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
