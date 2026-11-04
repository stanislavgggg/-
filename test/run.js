// Offline tests: no Telegram, no network. Run: npm test
const assert = require('assert');
const path = require('path');

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

const config = {
  ...require('../src/config'),
  setsUrl: '', matchesPath: path.join(__dirname, '..', 'data-sample', 'matches.json'),
  leagues: ['NHL', 'Virslīga', 'virslīga', 'Latvijas', 'IIHF'], minShare: 0.5, aiLabel: 'MI',
  groupChatId: '-100888', groupTitle: 'Lucky Latvia', groupFallbackUrl: 'https://t.me/+fallback',
};

const { openDb } = require('../src/db');
const { createApi, normalizeMatch } = require('../src/api');
const { createFunnel } = require('../src/funnel');
const { games } = require('../src/texts');

const sent = [];
const createdLinks = [];
const members = new Map();
const tg = {
  async send(id, html, extra) { sent.push({ id, html, extra }); },
  async createInviteLink(name) { createdLinks.push(name); return `https://t.me/+inv_${name}`; },
  async memberStatus(id) { return members.get(id) || 'left'; },
};
const db = openDb(':memory:');
const api = createApi(config, { cacheMs: Infinity, getOverride: (id) => db.getResult(id) });
const funnel = createFunnel({ db, api, config, tg, now: () => clock });

const MIN = 60_000;
const HOUR = 60 * MIN;
let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1; }
}
const last = () => sent[sent.length - 1];
const mine = (id, re) => sent.filter((s) => s.id === id && re.test(s.html));
const btns = (m) => (m.extra.reply_markup?.inline_keyboard || []).flat();
const INVITE = /Grupā katru dienu/;
const memberUpdate = (userId, from, to, linkName) => ({
  chat: { id: -100888 }, old_chat_member: { status: from, user: { id: userId } },
  new_chat_member: { status: to, user: { id: userId } }, invite_link: linkName ? { name: linkName } : undefined,
});

(async () => {
  const A = { id: 3000, first_name: 'Jānis' }; // even -> invite after first pick
  const B = { id: 3001, first_name: 'Līga' };  // odd  -> invite after first result

  await t('Latvian singular/plural for "spēle"', async () => {
    assert.deepStrictEqual([1, 2, 5, 11, 21, 22, 31].map(games), ['spēle', 'spēles', 'spēles', 'spēles', 'spēle', 'spēles', 'spēle']);
  });

  await t('normalizer: hockey, final incl. OT, draws rejected, other sports dropped', async () => {
    const m = normalizeMatch({ id: 'x', sport: 'hockey', home: 'A', away: 'B', start: 1893456000,
      models: [{ pick: 'B' }, { pick: '2' }, { pick: 'home' }], result: { score: '2:3' } });
    assert.strictEqual(m.consensus, 'away');
    assert.strictEqual(m.result.outcome, 'away');
    assert.strictEqual(normalizeMatch({ id: 'y', sport: 'hockey', home: 'A', away: 'B', result: { score: '2:2' } }).result, null);
    assert.strictEqual(normalizeMatch({ id: 'z', sport: 'basketball', home: 'A', away: 'B' }).inSport, false);
  });

  let adminRows;
  await t('admin match list: other sports excluded, hidden ones marked', async () => {
    adminRows = await funnel.upcomingForAdmin();
    assert.ok(!adminRows.find((r) => r.id === 'bb-001'), 'basketball record dropped');
    assert.ok(adminRows.find((r) => r.id === 'hk-004' && r.usable === false), 'SHL hidden by league filter');
    assert.ok(adminRows.find((r) => r.id === 'hk-001' && r.usable === true));
  });

  await t('slate: NHL + Latvian league, no low-confidence; two buttons; OT note', async () => {
    await funnel.onStart(A, 'lv_q1');
    const q = last();
    assert.match(q.html, /Spēle 1 no 2: North Bears-test – South Hawks-test/);
    assert.match(q.html, /papildlaiku un pēcspēles metienus/);
    assert.deepStrictEqual(btns(q).map((b) => b.callback_data), ['pick:hk-001:home', 'pick:hk-001:away']);
    assert.strictEqual(mine(3000, /Vai tu lasi hokeju labāk nekā MI/).length, 1);
  });

  await t('variant A: reveal + invite with a per-source link right after the first pick', async () => {
    await funnel.onPick(A, 'hk-001', 'away');
    assert.strictEqual(mine(3000, /Drosmīga izvēle: <b>South Hawks-test<\/b>\. 3 no 4 modeļiem izvēlas <b>North Bears-test/).length, 1);
    const inv = last();
    assert.match(inv.html, INVITE);
    assert.match(inv.html, /18\+/);
    assert.strictEqual(btns(inv)[0].url, 'https://t.me/+inv_b_lv_q1');
    assert.match(btns(inv)[0].text, /Pievienoties Lucky Latvia/);
  });

  await t('join through the bot link is attributed; forwarded-link joins count; unrelated ignored', async () => {
    await funnel.onChatMember(memberUpdate(3000, 'left', 'member', 'b_lv_q1'));
    assert.ok(db.getUser(3000).joined_at);
    assert.strictEqual(mine(3000, /Laipni lūdzam Lucky Latvia/).length, 1);
    await funnel.onChatMember(memberUpdate(9999, 'left', 'member', 'b_lv_q1'));
    await funnel.onChatMember(memberUpdate(8888, 'left', 'member', 'other_link'));
    assert.deepStrictEqual(db.joinStats(), [{ src: 'lv_q1', joins: 2, from_bot_users: 1 }]);
  });

  await t('variant B: no invite on pick; agreement text', async () => {
    await funnel.onStart(B, 'lv_q2');
    await funnel.onPick(B, 'hk-001', 'home');
    assert.strictEqual(mine(3001, INVITE).length, 0);
    assert.match(last().html, /Sakrīt ar MI/);
  });

  await t('picks lock 5 min before face-off', async () => {
    clock += 86 * MIN;
    await funnel.onPick({ id: 4000 }, 'hk-001', 'home');
    assert.match(last().html, /slēgta/);
  });

  await t('admin /result (OT final) grades; B gets the invite after the first result', async () => {
    clock += 170 * MIN;
    const r = await funnel.tick();
    assert.ok(r.some((x) => x.kind === 'grade' && x.res.startsWith('retry')));
    assert.strictEqual((await funnel.setResult('hk-001', '2:2', 1)).ok, false);
    assert.strictEqual((await funnel.setResult('hk-001', '3 - 2', 1)).ok, true);
    clock += 31 * MIN;
    await funnel.tick();
    assert.strictEqual(mine(3000, /Šoreiz nē · MI trāpīja/).length, 1);
    const gb = mine(3001, /Trāpīji · MI trāpīja/)[0];
    assert.ok(gb && /Tu 1 – 1 MI/.test(gb.html) && /Sērija: 1/.test(gb.html));
    const invB = mine(3001, INVITE);
    assert.strictEqual(invB.length, 1);
    assert.strictEqual(btns(invB[0])[0].url, 'https://t.me/+inv_b_lv_q2');
  });

  await t('getChatMember fallback marks the join', async () => {
    members.set(3001, 'member');
    clock += 16 * MIN;
    await funnel.tick();
    assert.strictEqual(db.getUser(3001).join_via, 'check');
  });

  await t('late invites only for players not in the group', async () => {
    await funnel.onStart({ id: 5000 }, 'lv_q3'); // never picks
    clock += 3 * 24 * HOUR;
    await funnel.tick();
    assert.strictEqual(mine(5000, INVITE).length, 0);
    assert.strictEqual(mine(3000, INVITE).length, 1);
  });

  await t('weekly top in Latvian', async () => {
    await funnel.onTop(B);
    assert.match(last().html, /Nedēļas līderi/);
    assert.match(last().html, /Līga — 1\/1/);
    assert.match(last().html, /Bez balvām/);
  });

  await t('stats by source', async () => {
    const st = db.stats().find((r) => r.src === 'lv_q1');
    assert.strictEqual(st.joined, 1);
  });

  Date.now = realNow;
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
