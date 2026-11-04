// 単語がどの学年(レベル)で習う語かを判定する。
// level: 0=小5 1=小6 2=中1 3=中2 4=中3 / 9=教科書にない語(ブランクにしない)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VOCAB = JSON.parse(fs.readFileSync(path.join(HERE, 'vocab.json'), 'utf8'));

// 歌詞にたくさん出る基本の機能語。語彙表になくても「知っている」扱い(小5)。
// ただし ブランクには なりにくい(fn=1)。
const FN = new Set(`a an the and but or so if of in on at to for with from by as than then that this these those
i me my mine you your yours he him his she her hers it its we us our ours they them their theirs
am is are was were be been being do does did done have has had will would can could shall should may might must
not no yes oh ah ooh yeah hey hmm la na uh whoa
who what when where why how which there here up down out off over into onto about
all some any one each every very too just only also more most much many`.split(/\s+/));

const IRREGULAR = {
  was:'be', were:'be', been:'be', am:'be', is:'be', are:'be', being:'be',
  went:'go', gone:'go', going:'go', saw:'see', seen:'see', had:'have', has:'have', having:'have',
  did:'do', done:'do', does:'do', made:'make', ate:'eat', eaten:'eat', took:'take', taken:'take',
  came:'come', got:'get', gotten:'get', gave:'give', given:'give', knew:'know', known:'know',
  said:'say', thought:'think', told:'tell', found:'find', felt:'feel', left:'leave', kept:'keep',
  began:'begin', begun:'begin', ran:'run', wrote:'write', written:'write', sang:'sing', sung:'sing',
  swam:'swim', flew:'fly', flown:'fly', drove:'drive', driven:'drive', bought:'buy', brought:'bring',
  caught:'catch', taught:'teach', heard:'hear', held:'hold', stood:'stand', sat:'sit', met:'meet',
  lost:'lose', paid:'pay', sent:'send', spent:'spend', built:'build', fell:'fall', fallen:'fall',
  broke:'break', broken:'break', spoke:'speak', spoken:'speak', chose:'choose', chosen:'choose',
  wore:'wear', worn:'wear', drew:'draw', drawn:'draw', grew:'grow', grown:'grow', threw:'throw',
  thrown:'throw', won:'win', slept:'sleep', rode:'ride', ridden:'ride', woke:'wake', forgot:'forget',
  forgotten:'forget', understood:'understand', children:'child', men:'man', women:'woman',
  feet:'foot', teeth:'tooth', mice:'mouse', people:'person', better:'good', best:'good',
  worse:'bad', worst:'bad', lives:'life', wives:'wife', leaves:'leaf', knives:'knife',
  cried:'cry', tried:'try', flies:'fly', ties:'tie', lies:'lie', dies:'die', died:'die', dying:'die',
  lying:'lie', tying:'tie', loved:'love', lived:'live', liked:'like',
};

function candidates(w) {
  const c = [];
  if (IRREGULAR[w]) c.push(IRREGULAR[w]);
  if (w.length > 3) {
    if (w.endsWith('ies')) c.push(w.slice(0, -3) + 'y');
    if (w.endsWith('es')) c.push(w.slice(0, -2));
    if (w.endsWith('s') && !w.endsWith('ss')) c.push(w.slice(0, -1));
    if (w.endsWith('ied')) c.push(w.slice(0, -3) + 'y');
    if (w.endsWith('ed')) { c.push(w.slice(0, -2)); c.push(w.slice(0, -1)); if (/(.)\1ed$/.test(w)) c.push(w.slice(0, -3)); }
    if (w.endsWith('ing')) { c.push(w.slice(0, -3)); c.push(w.slice(0, -3) + 'e'); if (/(.)\1ing$/.test(w)) c.push(w.slice(0, -4)); }
    if (w.endsWith('er')) { c.push(w.slice(0, -2)); c.push(w.slice(0, -1)); if (/(.)\1er$/.test(w)) c.push(w.slice(0, -3)); }
    if (w.endsWith('est')) { c.push(w.slice(0, -3)); c.push(w.slice(0, -2)); if (/(.)\1est$/.test(w)) c.push(w.slice(0, -4)); }
    if (w.endsWith('ly')) c.push(w.slice(0, -2));
    if (w.endsWith('ier')) c.push(w.slice(0, -3) + 'y');
    if (w.endsWith('iest')) c.push(w.slice(0, -4) + 'y');
  }
  return c.filter((x) => x.length >= 2);
}

/** @returns {{lv:number, ja:string, fn:0|1}} */
export function gradeWord(raw) {
  const w = raw.toLowerCase().replace(/[’‘]/g, "'");
  if (FN.has(w)) {
    const v = VOCAB[w];
    return { lv: 0, ja: v ? v[1] : '', fn: 1 };
  }
  if (VOCAB[w]) return { lv: VOCAB[w][0], ja: VOCAB[w][1], fn: 0 };
  for (const c of candidates(w)) {
    if (FN.has(c)) return { lv: 0, ja: '', fn: 1 };
    if (VOCAB[c]) return { lv: VOCAB[c][0], ja: VOCAB[c][1], fn: 0 };
  }
  return { lv: 9, ja: '', fn: 0 };
}

/**
 * 1行の歌詞 → トークン配列。
 * トークン = [前の記号, 単語, 後ろの記号, レベル, 日本語, 機能語?]
 * 単語が「ブランクにできる」条件: アルファベットだけ・3文字以上・レベル<=4
 */
export function tokenizeLine(text) {
  const tokens = [];
  for (const chunk of text.trim().split(/\s+/)) {
    if (!chunk) continue;
    const m = chunk.match(/^([^A-Za-z]*)([A-Za-z][A-Za-z'’\-]*[A-Za-z]|[A-Za-z])([^A-Za-z]*)$/);
    if (!m) { tokens.push([chunk, '', '', 9, '', 0]); continue; }
    const [, p, core, s] = m;
    const simple = /^[A-Za-z]+$/.test(core);
    const g = simple ? gradeWord(core) : { lv: 9, ja: '', fn: 0 };
    tokens.push([p, core, s, g.lv, g.ja, g.fn]);
  }
  return tokens;
}
