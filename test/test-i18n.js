// Every language file has the same strings as English, keeps its placeholders, and is served.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
const DATA = path.join(os.tmpdir(), 'fisync-i18n-test-' + process.pid);
process.env.PORT = '18499';
process.env.FISYNC_DATA = DATA;
process.env.SHARE_DIR = path.join(os.tmpdir(), 'fisync-i18n-share-' + process.pid);
const srv = require('../server');
const dir = path.join(__dirname, '..', 'public', 'i18n');

const EXPECTED = ['en', 'bg', 'hr', 'cs', 'da', 'nl', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'ga', 'it',
  'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv'];

(async () => {
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
  assert.deepStrictEqual(files, [...EXPECTED].sort(), 'all 24 EU official languages are present');
  for (const code of EXPECTED) {
    const table = JSON.parse(fs.readFileSync(path.join(dir, code + '.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(table).sort(), Object.keys(en).sort(), `${code} has every string`);
    for (const [k, v] of Object.entries(table)) {
      assert.ok(String(v).trim().length > 0, `${code}.${k} is not empty`);
      for (const ph of en[k].match(/\{\w+\}/g) || []) assert.ok(v.includes(ph), `${code}.${k} keeps ${ph}`);
    }
  }
  console.log(`ok  ${EXPECTED.length} languages: same strings and placeholders as English`);

  await srv.start({ approve: async () => true });
  const res = await new Promise((resolve, reject) => {
    require('http').get('http://127.0.0.1:18499/i18n/de.json', r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'], body: d }));
    }).on('error', reject);
  });
  assert.strictEqual(res.status, 200);
  assert.ok(/application\/json/.test(res.type));
  assert.deepStrictEqual(Object.keys(JSON.parse(res.body)).sort(), Object.keys(en).sort());
  console.log('ok  the phone page serves its language files');

  console.log('\nLanguage checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
