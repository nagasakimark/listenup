// 歌詞のチェック(きびしめ)。
//  ・ことわる(reject): 悪いことば / おさけ・たばこ・くすり / 性的 / 暴力 / 「hate」が3回以上
//  ・要確認(review): まぎらわしいことば(high, die, body など)。行ごと REVIEW.txt に出す。先生・Claudeが読んで決める
// 歌詞を見るだけなので、音声にしかない ことばは見つけられません (REVIEW.txt を読んでください)。
const PROFANITY = /^(fuck\w*|motherfuck\w*|shit\w*|bullshit|bitch\w*|bastards?|asshole\w*|dick\w*|cock|pussy|slut\w*|whore\w*|nigg\w*|cunt\w*|fag\w*|damn\w*|goddamn\w*|ass|arse\w*|piss\w*|crap|screw(?:ed)?|hell|hella|wtf|sucks?)$/i;
const CATS = {
  'おさけ': /^(drink\w*|drunk\w*|beer|wine|vodka|whisk\w*|booze|boozy|champagne|liquor|tequila|cocktail\w*|tipsy|hangover|margarita|rum|bourbon|alcohol\w*)$/i,
  'たばこ・くすり': /^(smok\w*|cigar\w*|weed|marijuana|joint|cocaine|coke|drugs?|pills?|molly|ecstasy|heroin|stoned|addict\w*|overdose\w*|dealer|junkie|narcotic\w*|inhale|overdosing)$/i,
  '性的': /^(sex\w*|naked|nude|seduc\w*|horny|lust\w*|strip|stripper|striptease|thighs?|bedroom|grind\w*|foreplay|erotic|booty|butt|boobs?|bra|panties|undress\w*|makeout|hooker|virgins?|orgasm\w*|banging)$/i,
  '暴力': /^(kill\w*|murder\w*|blood\w*|bloody|guns?|gunshots?|knife|stab\w*|bombs?|weapons?|suicid\w*|corpse|slaughter\w*|massacre|torture\w*|terror\w*|assault\w*|rape\w*|violen\w*|bullets?|trigger)$/i,
};
const HATE = /^(hate\w*|hating|haters?)$/i;
const REVIEW = /^(wasted|toast\w*|cheers|shots?|bottles?|high|higher|highest|die|dies|died|dying|dead|death|deadly|burn\w*|bury|buried|grave\w*|devil\w*|demons?|sins?|sinner\w*|shoot\w*|shot|body|bodies|bed|touch\w*|kiss\w*|lips|skin|hips?|freak\w*|dirty|naughty|hurt\w*|pain\w*|cry\w*|tears?|crazy|insane|mad|angry|rage|fight\w*|war|battle|enemy|enemies|danger\w*|dark|darkness|lonely|alone|sorrow|nobody|numb|scar\w*|bleed\w*|wound\w*|broken|break\w*|fall|falling|lie|lies|liar|stupid|idiot|fool|dumb|ugly|fat|loser|jealous\w*|tonight)$/i;

/**
 * @returns {{strong: Record<string,number>, hard: Record<string,number>, review: Record<string,number>, ctx: Record<string,string[]>}}
 *  strong = 悪いことば, hard = ほかの「ことわる」理由 (カテゴリ付き), review = 要確認
 */
export function scanLines(lines) {
  const strong = {}, hard = {}, review = {}, ctx = {};
  const add = (o, k) => { o[k] = (o[k] || 0) + 1; };
  let hate = 0;
  for (const l of lines) {
    const text = l.w.map((w) => w[0] + w[1] + w[2]).join(' ');
    for (const w of l.w) {
      const [p, core, s] = w;
      const c = (core || '').toLowerCase();
      if (!c) { if (/\*/.test(p)) add(strong, '(*でふせ字)'); continue; }
      const parts = c.split(/[-'’]/).filter(Boolean);
      if (PROFANITY.test(c) || PROFANITY.test(c.replace(/[-'’]/g, '')) || parts.some((x) => PROFANITY.test(x))) { add(strong, c); continue; }
      if ((c === 'f' || c === 's') && /^[-*]+$/.test(s)) { add(strong, '(ふせ字 ' + c + s + ')'); continue; }
      if (/\*/.test(s)) { add(strong, '(*でふせ字)'); continue; }
      let hit = false;
      for (const [cat, re] of Object.entries(CATS)) if (re.test(c)) { add(hard, `${cat}:${c}`); hit = true; break; }
      if (hit) continue;
      if (HATE.test(c)) { hate++; add(review, c); }
      else if (REVIEW.test(c)) { add(review, c); (ctx[c] ||= []).length < 2 && ctx[c].push(text); }
    }
  }
  if (hate >= 3) hard['hate(にくしみ):' + hate + '回'] = hate;
  return { strong, hard, review, ctx };
}
export const rejectReason = (sc) => {
  const f = (o) => Object.entries(o).map(([k, n]) => `${k}×${n}`).join(' ');
  const parts = [];
  if (Object.keys(sc.strong).length) parts.push('悪いことば ' + f(sc.strong));
  if (Object.keys(sc.hard).length) parts.push('おさけ/くすり/性的/暴力/にくしみ ' + f(sc.hard));
  return parts.join(' / ');
};
