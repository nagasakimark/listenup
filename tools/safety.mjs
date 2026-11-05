// 歌詞のチェック: 悪いことば(strong)は追加をことわる。気になることば(mild)は REVIEW.txt に書き出して先生が判断。
const STRONG = /^(fuck\w*|motherfuck\w*|shit\w*|bullshit|bitch\w*|bastards?|asshole\w*|dick\w*|cock|pussy|slut\w*|whore\w*|nigg\w*|cunt\w*|fag\w*|damn\w*|goddamn\w*|ass|arse\w*|piss\w*|crap|screw(?:ed)?)$/i;
const MILD = /^(sexy|sexual|sex|naked|kiss\w*|drunk|wasted|drinks?|drinking|beer|wine|vodka|whiskey|booze|stoned|weed|cigarette\w*|cocaine|drugs?|pills?|kill\w*|murder\w*|blood\w*|guns?|shoot\w*|suicide|devil|demons?|sins?|lust|thighs?|bed|bedroom|seduc\w*|strip\w*|grind\w*|hell|freak\w*|horny|dirty|naughty|touch|body|bodies|hate)$/i;

/** @returns {{strong: Record<string,number>, mild: Record<string,number>}} */
export function scanLines(lines) {
  const strong = {}, mild = {};
  const add = (o, k) => { o[k] = (o[k] || 0) + 1; };
  for (const l of lines) {
    for (const w of l.w) {
      const [p, core, s] = w;
      const c = (core || '').toLowerCase();
      if (!c) { if (/\*/.test(p)) add(strong, '(*でふせ字)'); continue; }
      if (STRONG.test(c)) add(strong, c);
      else if ((c === 'f' || c === 's') && /^[-*]+$/.test(s)) add(strong, '(ふせ字 ' + c + s + ')');
      else if (/\*/.test(s)) add(strong, '(*でふせ字)');
      else if (MILD.test(c)) add(mild, c);
    }
  }
  return { strong, mild };
}
