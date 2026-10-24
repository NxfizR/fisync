// Sends the nearby Bluetooth beacon through BlueZ, the Linux Bluetooth service, as a service ID.
// Needs BlueZ running, a Bluetooth adapter at /org/bluez/hci0, and the dbus-next package (npm install).
// Untested on hardware at the time of writing: please report what happens.
const fs = require('fs');
const dbus = require('dbus-next');
const { beaconUuid } = require('../remote');
const Interface = dbus.interface.Interface;

const beaconFile = process.argv[2];
if (!beaconFile) {
  console.error('usage: node beacon-linux.js <beacon file>');
  process.exit(2);
}

class Advertisement extends Interface {
  constructor(uuid) {
    super('org.bluez.LEAdvertisement1');
    this._uuid = uuid;
  }
  get Type() { return 'broadcast'; }
  get ServiceUUIDs() { return [this._uuid]; }
  Release() { /* BlueZ asks us to stop; the next update registers a new one */ }
}
Advertisement.configureMembers({
  properties: {
    Type: { signature: 's', access: 'read' },
    ServiceUUIDs: { signature: 'as', access: 'read' },
  },
  methods: { Release: { inSignature: '', outSignature: '' } },
});

(async () => {
  const bus = dbus.systemBus();
  const adapter = await bus.getProxyObject('org.bluez', '/org/bluez/hci0');
  const manager = adapter.getInterface('org.bluez.LEAdvertisingManager1');
  let current = null;
  let counter = 0;
  let last = '';

  async function apply() {
    let hex = '';
    try { hex = JSON.parse(fs.readFileSync(beaconFile, 'utf8')).hex || ''; } catch { return; }
    if (!hex || hex === last) return;
    if (current) {
      try { await manager.UnregisterAdvertisement(current); } catch { /* already gone */ }
      bus.unexport(current);
    }
    counter++;
    const objectPath = `/com/fisync/beacon${counter}`;
    bus.export(objectPath, new Advertisement(beaconUuid(hex)));
    await manager.RegisterAdvertisement(objectPath, {});
    current = objectPath;
    last = hex;
    console.log('beacon on');
  }

  await apply();
  setInterval(() => apply().catch(e => console.error(e.message)), 20000);
})().catch(e => {
  console.error('Bluetooth beacon failed:', e.message);
  process.exit(1);
});
