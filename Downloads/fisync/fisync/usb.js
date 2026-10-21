// Connects a phone over USB (USB debugging on) by forwarding the phone's port 8484 to this computer.
// Traffic then travels over the cable instead of Wi-Fi. Run again after unplugging and reconnecting.
const { execFile } = require('child_process');

const run = (cmd, args) => new Promise(resolve => execFile(cmd, args, { timeout: 15000 },
  (err, out, errOut) => resolve({ err, out: String(out || ''), errOut: String(errOut || '') })));

async function forwardUsb(port = Number(process.env.PORT) || 8484) {
  const devices = await run('adb', ['devices']);
  if (devices.err) return { ok: false, msg: 'adb was not found. Install Android platform-tools and add it to your PATH.' };
  const phones = devices.out.split('\n').filter(l => /\sdevice$/.test(l.trim()));
  if (!phones.length) return { ok: false, msg: 'No authorised phone found. Plug in the phone, turn on USB debugging, and tap Allow on the phone.' };
  const forward = await run('adb', ['reverse', `tcp:${port}`, `tcp:${port}`]);
  if (forward.err) return { ok: false, msg: (forward.errOut || forward.err.message).trim() };
  return { ok: true, msg: `Connected over USB. On the phone, open localhost:${port} in the browser, or use "Use USB" in the Android app.` };
}

module.exports = { forwardUsb };

if (require.main === module) {
  forwardUsb().then(r => { console.log(r.msg); process.exit(r.ok ? 0 : 1); });
}
