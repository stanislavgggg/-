# Tu pret MI — hockey pick'em for Latvia (GG Group)

Latvian version of the "You vs AI" game for the **GG Group** LV line, built on the same engine as the Lithuanian bot. The user picks who wins NHL / Latvian league / IIHF games — **the final result including overtime and shootout**, so two outcomes and no draws — then sees what the AI models picked and why. After each game: right or wrong, streak, the score **Tu pret MI**, weekly rank. The funnel ends in the **Lucky Latvia** group, and every join is attributed to the ad source.

No betting operator, bonus or prize inside the bot — a free hockey game. The group invite says it's 18+. KHL is deliberately not in the default leagues.

## Flow

1. `/start <source>` → intro + first game question (up to 5 games in the next 48 h; only `LEAGUES`; only games where at least `MIN_SHARE` of models agree; "needs a human" placeholders never shown). Picks close 5 min before face-off. Times in Europe/Riga.
2. **Reveal** after each pick: "Sakrīt ar MI" or "Drosmīga izvēle — 3 no 4 modeļiem izvēlas …" + the AI's main reason.
3. **Grading** ~2 h 45 min after face-off, re-checked every 30 min for up to ~8 h (results from the source or entered by an admin with `/result`).
4. **Invite to Lucky Latvia — A/B by telegram_id:** **A** (even) right after the first pick · **B** (odd) after the first graded result. Late invites at +26 h and +72 h for players not in the group yet. Max 3 invites per user.
5. **Join tracking:** one invite link per ad source (`b_<source>`) created by the bot; membership updates attribute each join to its source, including people who got the link forwarded. Fallback `getChatMember` check 15 min and 24 h after each invite. Leaving the group is recorded.
6. **Daily push** for 14 days when games are open.

## Predictions source — pick one

- **External export:** `SETS_URL` + `SETS_TOKEN` (if your prediction bot adds hockey).
- **File on the volume:** leave `SETS_URL` empty; `data-sample/matches.json` is copied to `MATCHES_PATH` (`/data/matches.json`) on first boot; edit and `/reload`. Per match: `id, sport, competition, home, away, start (ISO with offset), models[{name, pick: home|away|team name, rationale}]`, optional `result{score}` — the final score incl. OT/shootout.
- Records with a `sport` field must match `SPORT_PATTERN` (hockey by default); other sports in a shared export are ignored.

**Honesty:** texts say "MI modeļi" (AI models). Keep `AI_LABEL=MI` only if the picks really come from models; otherwise change the label and the intro.

## Admin commands

- `/matches` — games for the next 7 days with ids, results, and which are hidden
- `/result <id> <home>:<away>` — final incl. OT/shootout, e.g. `/result hk-001 3:2` (draws rejected)
- `/reload` — re-read `matches.json` (keeps the old data if the file is broken)
- `/stats` — by source × variant: starts, picked, invited, joined, left, blocked; plus group joins by source

## Setup (Railway)

1. Volume at `/data`, variables from `.env.example`, `npm start` (long polling).
2. Add the bot to **Lucky Latvia as an admin** with only "Invite users via link". Without it invites fall back to `GROUP_FALLBACK_URL` and joins aren't tracked (the bot warns at startup).
3. `GROUP_CHAT_ID` — the group's numeric id (`-100…`).
4. Telegram Ads: `https://t.me/<bot>?start=lv_<code>` — one code per ad / host channel.

## Texts

All copy is in `src/texts.js` (Latvian). **Have a native speaker proofread it before launch.** Bot name, description and ads: `/tg-funnel-builder`.

## Tests

`npm test` — offline: Latvian singular/plural, hockey normalizer (OT finals, draws rejected, other sports dropped), admin list, slate filters, reveal, A/B invite timing, per-source invite links, join attribution incl. forwarded links, admin result entry and grading, getChatMember fallback, late invites, weekly top, stats.
