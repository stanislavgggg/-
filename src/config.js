const path = require('path');

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

const config = {
  botToken: process.env.BOT_TOKEN || '',
  adminIds: list(process.env.ADMIN_IDS).map(Number),
  port: Number(process.env.PORT || 3000),
  timeZone: process.env.TIME_ZONE || 'Europe/Riga',

  // Predictions source:
  //   SETS_URL set     -> external JSON export (bearer token), same shape as matches.json
  //   otherwise        -> MATCHES_PATH file on the volume, edited by the team (+ /reload)
  setsUrl: process.env.SETS_URL || '',
  setsToken: process.env.SETS_TOKEN || '',
  matchesPath: process.env.MATCHES_PATH || path.join(__dirname, '..', 'data', 'matches.json'),
  matchesSample: path.join(__dirname, '..', 'data-sample', 'matches.json'),
  // Records with a "sport" field must match this (regex, case-insensitive)
  sportPattern: process.env.SPORT_PATTERN || 'hockey|hokej|nhl|iihf|virsl[iī]g',
  leagues: list(process.env.LEAGUES || 'NHL,Virslīga,Latvijas,IIHF'),
  minShare: Number(process.env.MIN_SHARE || 0.5),

  // How the opponent is called. "MI" = mākslīgais intelekts. Keep it only if picks really come from models.
  aiLabel: process.env.AI_LABEL || 'MI',

  // Lucky Latvia group. For join tracking the bot must be an admin there with "invite users" rights.
  groupChatId: process.env.GROUP_CHAT_ID || '',
  groupFallbackUrl: process.env.GROUP_FALLBACK_URL || '',
  groupTitle: process.env.GROUP_TITLE || 'Lucky Latvia',

  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bot.sqlite'),
  tickSeconds: Number(process.env.TICK_SECONDS || 60),
};

module.exports = config;
