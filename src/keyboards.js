const { Markup } = require('telegraf');

function create(T) {
  return {
    question: (m) => Markup.inlineKeyboard([[
      Markup.button.callback(String(m.home).slice(0, 30), `pick:${m.id}:home`),
      Markup.button.callback(String(m.away).slice(0, 30), `pick:${m.id}:away`),
    ]]),
    afterPick: (hasMore) => Markup.inlineKeyboard([
      hasMore ? [Markup.button.callback(T.btn.next, 'slate')] : [Markup.button.callback(T.btn.top, 'top')],
      [Markup.button.callback(T.btn.me, 'me')],
    ]),
    graded: () => Markup.inlineKeyboard([[Markup.button.callback(T.btn.slate, 'slate'), Markup.button.callback(T.btn.top, 'top')]]),
    slate: () => Markup.inlineKeyboard([[Markup.button.callback(T.btn.slate, 'slate')]]),
    menu: () => Markup.inlineKeyboard([
      [Markup.button.callback(T.btn.slate, 'slate')],
      [Markup.button.callback(T.btn.top, 'top'), Markup.button.callback(T.btn.me, 'me')],
    ]),
    join: (url) => Markup.inlineKeyboard([[Markup.button.url(T.btn.join, url)]]),
  };
}

module.exports = { create };
