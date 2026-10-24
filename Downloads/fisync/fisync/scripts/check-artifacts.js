// Checks the release files before they are published. Exit code 1 means something is wrong.
// Usage: node scripts/check-artifacts.js desktop <folder>
//        node scripts/check-artifacts.js apk <folder>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function checkDesktop(dir, minBytes = 5e6) {
  if (!fs.existsSync(dir)) return [`folder not found: ${dir}`];
  const problems = [];
  const files = fs.readdirSync(dir);
  const installers = files.filter(f => /\.(exe|AppImage)$/.test(f));
  if (!installers.length) problems.push('no Windows or Linux installer was built');
  for (const f of installers) {
    const size = fs.statSync(path.join(dir, f)).size;
    if (size < minBytes) problems.push(`${f} is only ${size} bytes, which is too small`);
  }
  if (installers.some(f => f.endsWith('.exe')) && !files.includes('latest.yml')) {
    problems.push('latest.yml is missing, so automatic updates cannot find the Windows build');
  }
  return problems;
}

function checkApk(dir, minBytes = 1e6) {
  if (!fs.existsSync(dir)) return [`folder not found: ${dir}`];
  const problems = [];
  const apks = fs.readdirSync(dir).filter(f => f.endsWith('.apk'));
  if (!apks.length) problems.push('no APK was built');
  for (const f of apks) {
    const file = path.join(dir, f);
    const size = fs.statSync(file).size;
    if (size < minBytes) problems.push(`${f} is only ${size} bytes, which is too small`);
    const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
    for (const need of ['classes.dex', 'AndroidManifest.xml', 'resources.arsc']) {
      if (!listing.includes(need)) problems.push(`${f} has no ${need}`);
    }
  }
  return problems;
}

module.exports = { checkDesktop, checkApk };

if (require.main === module) {
  const [kind, dir] = process.argv.slice(2);
  const problems = kind === 'apk' ? checkApk(dir) : checkDesktop(dir);
  if (problems.length) {
    for (const p of problems) console.error('x ' + p);
    process.exit(1);
  }
  console.log('release files look right');
}
