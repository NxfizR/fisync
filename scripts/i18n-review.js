// Builds a review sheet for native speakers: every string next to its English original, with warnings.
// Usage: node scripts/i18n-review.js public/i18n review.csv
const fs = require('fs');
const path = require('path');

function reviewSheet(dir) {
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
  const rows = [];
  const warnings = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'en.json').sort()) {
    const code = file.slice(0, -5);
    const table = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const key of Object.keys(en)) {
      const text = table[key] || '';
      rows.push({ language: code, key, english: en[key], text });
      if (!text) warnings.push(`${code}.${key}: empty`);
      else if (text.length > en[key].length * 2 + 12) warnings.push(`${code}.${key}: much longer than English (${text.length} against ${en[key].length} characters), check that it fits`);
      if (text && text === en[key] && /[a-zA-Z]{3,}/.test(text)) warnings.push(`${code}.${key}: same as English, maybe not translated`);
      for (const ph of en[key].match(/\{\w+\}/g) || []) {
        if (!text.includes(ph)) warnings.push(`${code}.${key}: placeholder ${ph} is missing`);
      }
    }
  }
  return { rows, warnings };
}

function toCsv(rows) {
  const cell = v => `"${String(v).replace(/"/g, '""')}"`;
  return ['language,key,english,translation', ...rows.map(r => [r.language, r.key, r.english, r.text].map(cell).join(','))].join('\n') + '\n';
}

module.exports = { reviewSheet, toCsv };

if (require.main === module) {
  const [dir, out] = process.argv.slice(2);
  const { rows, warnings } = reviewSheet(dir);
  fs.writeFileSync(out, toCsv(rows));
  console.log(`wrote ${rows.length} rows to ${out}`);
  for (const w of warnings) console.log('check: ' + w);
}
