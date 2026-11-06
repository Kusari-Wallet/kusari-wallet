const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '../locales');
const LANGUAGES = ['ko', 'ja', 'zh-CN', 'vi', 'pt', 'tr', 'uk', 'ru'];
const load = (code) => JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), 'utf8'));
const gaps = (s) => (s.match(/\{\d\}/g) ?? []).sort();
const ALWAYS = /\b(?:BTC|XMR|ETH|TRX|USDT|ZEC|ZANO|ARRR|DASH|FIRO|SOL|DOGE|Tor|KYC|BIP39)\b/g;

for (const code of LANGUAGES) {
  test(`${code}: gaps, coin names and numbers all survive translation`, () => {
    const dictionary = load(code);
    for (const [source, text] of Object.entries(dictionary)) {
      assert.ok(text.trim(), source);
      assert.deepEqual(gaps(text), gaps(source), source);
      for (const name of source.match(ALWAYS) ?? []) assert.ok(text.includes(name), `${name} missing: ${source} => ${text}`);
      for (const n of (source.replace(/\{\d\}/g, '').match(/\b\d+\b/g) ?? [])) assert.ok(text.includes(n), `${n} missing: ${source} => ${text}`);
    }
  });
}

test('every language translates the same text', () => {
  const keys = Object.keys(load('ko')).sort();
  assert.ok(keys.length > 600);
  for (const code of LANGUAGES) assert.deepEqual(Object.keys(load(code)).sort(), keys, code);
});
