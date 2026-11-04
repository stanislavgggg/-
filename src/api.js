// Matches + model picks for one sport (SPORT_PATTERN). Two outcomes: 'home' | 'away' —
// the final result including overtime / shootout, so there are no draws.
// Source: external export (SETS_URL) or a JSON file on the volume (MATCHES_PATH).
// Results come from the source or from admin overrides (/result) stored in the DB.

const fs = require('fs');
const path = require('path');

function pick(obj, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const rel = /^now([+-]\d+)$/.exec(String(v)); // test fixtures: minutes from now
  if (rel) return Date.now() + Number(rel[1]) * 60_000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const norm = (s) => String(s || '').trim().toLowerCase();
const DEFAULT_SPORT = /hockey|hokej|nhl|iihf|virsl[iī]g/i;
const inSport = (raw, re = DEFAULT_SPORT) => !raw || re.test(String(raw));

function side(value, home, away) {
  const v = norm(value);
  if (!v) return null;
  if (['home', '1', 'h', 'mājas', 'majas', 'mājinieki'].includes(v) || v === norm(home)) return 'home';
  if (['away', '2', 'a', 'viesi', 'viesiem'].includes(v) || v === norm(away)) return 'away';
  return null;
}

function sideFromScore(score) {
  const m = /^\s*(\d+)\s*[:\-–]\s*(\d+)\s*$/.exec(String(score || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const a = Number(m[2]);
  return h === a ? null : h > a ? 'home' : 'away';
}

const LOW_CONFIDENCE = /needs a human/i;

function normalizeMatch(s, sportRe = DEFAULT_SPORT) {
  const home = pick(s, ['home', 'match.home', 'team_a', 'match.team_a', 'teams.0.name', 'teams.0']);
  const away = pick(s, ['away', 'match.away', 'team_b', 'match.team_b', 'teams.1.name', 'teams.1']);
  const competition = String(pick(s, ['competition', 'match.competition', 'league', 'tournament', 'match.tournament']) || '');
  const sport = pick(s, ['sport', 'game', 'discipline', 'category']);

  const modelsRaw = pick(s, ['models', 'predictions', 'model_predictions']) || [];
  const models = (Array.isArray(modelsRaw) ? modelsRaw : Object.entries(modelsRaw).map(([name, v]) => ({ name, ...v })))
    .map((m) => ({
      name: pick(m, ['name', 'model', 'id']) || 'Modelis',
      side: side(pick(m, ['pick', 'winner', 'prediction', 'side']), home, away),
      rationale: pick(m, ['rationale', 'reason', 'reasoning', 'why']) || '',
    }))
    .filter((m) => m.side);

  const tally = { home: 0, away: 0 };
  for (const m of models) tally[m.side]++;
  let consensus = side(pick(s, ['consensus.pick', 'consensus']), home, away);
  if (!consensus && models.length) consensus = tally.home >= tally.away ? 'home' : 'away';

  const r = pick(s, ['result']);
  let result = null;
  if (r && typeof r === 'object') {
    const score = String(pick(r, ['score', 'final_score']) || '');
    const outcome = side(pick(r, ['winner', 'outcome']), home, away) || sideFromScore(score);
    if (outcome) result = { score, outcome };
  }

  const text = models.map((m) => m.rationale).join(' ') + ' ' + String(pick(s, ['note']) || '');
  return {
    id: String(pick(s, ['id', 'match_id', 'set_id']) || `${home}-${away}-${pick(s, ['start', 'start_time'])}`),
    // A record with a sport field must match SPORT_PATTERN; records without one are kept (LEAGUES filters them).
    inSport: sport ? inSport(sport, sportRe) : true,
    home: home && String(home),
    away: away && String(away),
    competition,
    startsAt: toMs(pick(s, ['start', 'start_time', 'starts_at', 'match.start_time', 'tipoff', 'date'])),
    consensus,
    agree: consensus ? tally[consensus] : 0,
    total: models.length,
    models,
    result,
    lowConfidence: LOW_CONFIDENCE.test(text),
  };
}

function isUsable(m, { minShare = 0.5, leagues = [] } = {}) {
  if (!m.inSport || !m.home || !m.away || !m.startsAt || !m.consensus || m.lowConfidence || !m.total) return false;
  if (m.agree / m.total < minShare) return false;
  if (leagues.length && !leagues.some((l) => m.competition.toLowerCase().includes(l.toLowerCase()))) return false;
  return true;
}

function ensureFile(config) {
  if (!config.setsUrl && !fs.existsSync(config.matchesPath) && fs.existsSync(config.matchesSample)) {
    fs.mkdirSync(path.dirname(config.matchesPath), { recursive: true });
    fs.copyFileSync(config.matchesSample, config.matchesPath);
  }
}

function createApi(config, { fetchImpl = global.fetch, cacheMs = 60_000, getOverride = () => null } = {}) {
  let cache = { at: 0, items: [] };

  async function loadRaw() {
    if (config.setsUrl) {
      const res = await fetchImpl(config.setsUrl, { headers: { Authorization: `Bearer ${config.setsToken}`, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`export HTTP ${res.status}`);
      return res.json();
    }
    ensureFile(config);
    const file = fs.existsSync(config.matchesPath) ? config.matchesPath : config.matchesSample;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  async function all() {
    if (cache.at && Date.now() - cache.at < cacheMs) return cache.items.map(withOverride);
    try {
      const raw = await loadRaw();
      const list = Array.isArray(raw) ? raw : (raw.matches || raw.sets || raw.items || raw.data || []);
      const re = config.sportPattern ? new RegExp(config.sportPattern, 'i') : DEFAULT_SPORT;
      cache = { at: Date.now(), items: list.map((x) => normalizeMatch(x, re)).filter((m) => m.inSport) };
    } catch (e) {
      console.error('[api] load failed:', e.message);
      if (!cache.items.length) throw e;
    }
    return cache.items.map(withOverride);
  }

  function withOverride(m) {
    const o = getOverride(m.id);
    if (!o) return m;
    const outcome = sideFromScore(o.score);
    return outcome ? { ...m, result: { score: o.score, outcome } } : m;
  }

  return {
    all,
    async byId(id) { return (await all()).find((m) => m.id === String(id)) || null; },
    isUsable: (m) => isUsable(m, { minShare: config.minShare, leagues: config.leagues }),
    reload() { cache = { at: 0, items: [] }; return all(); },
  };
}

module.exports = { createApi, normalizeMatch, isUsable, side, sideFromScore, inSport };
