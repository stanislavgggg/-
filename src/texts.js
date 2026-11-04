// Teksti (latviešu valodā). Bezmaksas spēle: lietotājs izvēlas uzvarētāju,
// pēc tam redz, ko izvēlējās MI modeļi; pēc spēles — rezultāts „Tu pret MI”.
// Balvu, naudas un derību operatoru botā nav.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtTime(ms, tz) {
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat('lv-LV', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('lv-LV', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return `${day}, ${time}`;
}

// Latvian: numbers ending in 1 (except 11) take the singular: 1/21/31 spēle, others spēles
const games = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'spēle' : 'spēles');

const label = (m, s) => (s === 'home' ? m.home : m.away);

function create(cfg) {
  const AI = cfg.aiLabel;
  const score = (u) => `Tu ${u.score_user} – ${u.score_ai} ${AI}`;

  return {
    esc,
    label,

    intro: () =>
      `<b>Vai tu lasi hokeju labāk nekā ${AI}?</b>\n\n` +
      `Izvēlies, kurš uzvarēs NHL un Latvijas hokeja spēlēs. Pēc tam redzēsi, ko izvēlējās mūsu ${AI} modeļi un kāpēc.\n\n` +
      `Pēc katras spēles: trāpīji vai nē, tava sērija un rezultāts <b>Tu pret ${AI}</b>. Bez maksas.`,

    question: (m, i, n) =>
      `🏒 <b>${n > 1 ? `Spēle ${i + 1} no ${n}: ` : ''}${esc(m.home)} – ${esc(m.away)}</b>\n` +
      `${m.competition ? esc(m.competition) + ', ' : ''}🕒 ${fmtTime(m.startsAt, cfg.timeZone)}\n\n` +
      'Kurš uzvarēs? <i>Skaitās gala rezultāts, ieskaitot papildlaiku un pēcspēles metienus.</i>',

    noSlate: () => 'Šobrīd nav atvērtu spēļu. Paziņosim, kad sāksies nākamā spēļu kārta.',
    allPicked: () => 'Tu jau esi izvēlējies visas atvērtās spēles. Paziņosim par katru rezultātu.',
    locked: () => '⛔ Šī spēle jau ir slēgta: tā sākas pēc mazāk nekā 5 minūtēm.',
    already: (m, p) => `Šajā spēlē tu jau izvēlējies <b>${esc(label(m, p.pick))}</b>. Viens minējums katrai spēlei.`,

    reveal(m, pick) {
      const why = m.models.find((x) => x.side === m.consensus && x.rationale)?.rationale || '';
      const head = pick === m.consensus
        ? `✅ Sakrīt ar ${AI}: <b>${esc(label(m, pick))}</b>.`
        : `🔥 Drosmīga izvēle: <b>${esc(label(m, pick))}</b>. ${m.agree} no ${m.total} modeļiem izvēlas <b>${esc(label(m, m.consensus))}</b>.`;
      return `${head}${why ? `\n\n${AI} galvenais iemesls: ${esc(why)}` : ''}\n\nRezultātu atsūtīsim, kad spēle beigsies.`;
    },

    graded(m, p, u, rank) {
      const lines = [
        `<b>${esc(m.home)} ${esc(m.result.score || '')} ${esc(m.away)}</b>`.replace(/\s+/g, ' '),
        `${p.correct ? '✅ Trāpīji' : '❌ Šoreiz nē'} · ${p.ai_correct ? `${AI} trāpīja` : `${AI} kļūdījās`}`,
        '',
        `Rezultāts: <b>${score(u)}</b>`,
        `Sērija: ${u.streak}${u.best_streak > u.streak ? ` (labākā: ${u.best_streak})` : ''}`,
      ];
      if (rank) lines.push(`Šonedēļ: #${rank.rank} no ${rank.of}`);
      return lines.join('\n');
    },

    invite: () =>
      `👥 <b>${esc(cfg.groupTitle)}</b>\n\n` +
      'Grupā katru dienu apspriežam spēles, sastāvus un statistiku. Pievienojies un salīdzini savus minējumus ar citiem hokeja faniem.\n\n' +
      'Grupa paredzēta 18+.',
    joined: () => `Laipni lūdzam ${esc(cfg.groupTitle)}! Spēle turpinās — nākamās spēles jau gaida.`,

    daily: (n) => `🗓️ Minējumiem atvērto spēļu skaits: <b>${n}</b>. Vai atkal apsteigsi ${AI}?`,

    top(rows, me) {
      if (!rows.length) return '🏆 <b>Nedēļas līderi</b>\n\nŠonedēļ vēl nav novērtētu minējumu.';
      const medal = ['🥇', '🥈', '🥉'];
      const lines = rows.map((r, i) =>
        `${medal[i] || `${i + 1}.`} ${esc(r.first_name || (r.username ? '@' + r.username : 'Spēlētājs'))} — ${r.wins}/${r.graded}`);
      return `🏆 <b>Nedēļas līderi</b> (trāpīts / novērtēts)\n\n${lines.join('\n')}` +
        (me ? `\n\nTu: #${me.rank} no ${me.of}, trāpīji ${me.wins}` : '') +
        '\n\nBez balvām — tikai godam.';
    },

    me: (u, n) => `<b>${score(u)}</b>\nSērija: ${u.streak}, labākā ${u.best_streak}\nMinējumi: ${n}`,

    btn: {
      next: '➡️ Nākamā spēle',
      slate: '🗓️ Atvērtās spēles',
      top: '🏆 Nedēļas līderi',
      me: '📊 Mans rezultāts',
      join: `👥 Pievienoties ${cfg.groupTitle}`.slice(0, 64),
    },
  };
}

module.exports = { create, games, fmtTime };
