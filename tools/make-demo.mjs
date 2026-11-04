// 動作テスト用のオリジナルのデモ曲(音なし)を作る。 node tools/make-demo.mjs
import fs from 'node:fs';
import { tokenizeLine } from './grade.mjs';
const text = [
  'Good morning, sunny day', 'I see a rainbow in the sky', 'Apples and bananas on the table',
  'My friend and I go to school', 'We sing and dance together', 'Music makes me happy',
  'Every night I look at the moon', 'The stars are shining bright', 'I will remember this smile',
  'Dream big and never stop', 'Summer, winter, spring and fall', 'Everyone is my friend',
  "Let's sing one more time", 'Good night, see you tomorrow',
];
const lines = text.map((s, i) => ({ t: 3 + i * 4, e: 3 + i * 4 + 3.6, w: tokenizeLine(s) }));
fs.writeFileSync(new URL('../songs/demo.json', import.meta.url), JSON.stringify({
  id: 'demo', yt: null, title: 'デモ曲 (おんがくなし)', artist: 'Listen Up!', dur: 62, source: 'demo', offset: 0, lines,
}));
console.log('demo ok', lines.length);
