# Use fisync away from home

fisync can reach your computer from any network in two ways:

- **Tailscale** (recommended): works anywhere, once. Your phone and computer join a private network that only your own devices can see.
- **Nearby Bluetooth**: when the phone is in the same room, it finds the computer's current address without any setup on the network. Bluetooth reaches only about 10 metres, so it is a fallback, not a replacement.

## Part 1: Tailscale (about 10 minutes)

Tailscale is a free app that links your devices. You don't need to know how it works. You only need to sign in with the same account on both devices.

1. **On the computer:** go to tailscale.com/download, install it, and sign in with an account you already have (Google, Microsoft or GitHub). Remember which account you used.
2. **On the phone:** install "Tailscale" from Google Play, open it, and sign in with the **same account**. Turn the switch on.
3. **In fisync on the computer:** open the phone panel, go to "Remote access", and click "Check Tailscale". It shows a name such as `my-pc.tail1234.ts.net`.
4. **In the fisync phone app:** in the address box, type that name followed by `:8484`, for example `my-pc.tail1234.ts.net:8484`. Enter the PIN as usual.
5. Keep Tailscale running on both devices. It starts with Windows and Android by default.

After this, the phone reaches the computer from any Wi-Fi or mobile network, and the address does not change when the network does.

**Things to know**
- Android allows only one VPN at a time. If you already use another VPN, Tailscale will replace it while it is on.
- If you reinstall fisync, the name stays the same. If you remove the computer from Tailscale's admin page, you need to repeat step 2 on the new one.
- Tailscale's free plan covers personal use at the time of writing. Check tailscale.com/pricing if you are unsure.
- If the phone still can't connect, check that Tailscale shows as connected on both devices, then try the name again. On Windows, if a firewall prompt appears for fisync, allow it on private networks.

## Part 2: Nearby Bluetooth (optional)

This helps when Tailscale isn't set up, or the network has changed and the phone is close to the computer.

1. **On the computer:** turn on Bluetooth, then in the phone panel under "Remote access" tick "Let nearby phones find this computer by Bluetooth for 10 minutes". It turns itself off after ten minutes; tick it again when you need it. Windows, macOS and Linux are supported. See the notes below for each.
2. **On the phone:** turn on Bluetooth. Allow "Nearby devices" when fisync asks. On Android 11 and earlier, also turn on Location, which Android requires for Bluetooth scanning.
3. Stand within a few metres of the computer. The phone finds the new address and connects. Nothing else needs to be typed.

**Notes for each computer**
- **Windows:** nothing extra to install.
- **macOS:** install the Xcode command line tools once, by running `xcode-select --install` in Terminal. The first time, macOS asks whether to allow Bluetooth for the app that runs fisync; choose Allow. The computer must be awake for the beacon to reach phones.
- **Linux:** needs BlueZ, the standard Bluetooth service, which most desktops already have. In a terminal in the fisync folder, run `npm install` once. Some distributions need the fisync command started with `sudo` before BlueZ allows the beacon.

**What the beacon reveals**
The beacon carries the computer's current network address and a hash of its ID. It holds no keys and no names. Anyone nearby with a Bluetooth scanner could see the address, but they could not connect without the pairing key, which the phone checks.

## Pairing with the Tailscale name

Under "Pair a phone" in the desk panel, "Show pairing code" now includes the computer's Tailscale name when Tailscale is running. Scanning it in the phone app fills in both the local address and the Tailscale name. If the phone is on the same Wi-Fi it uses the local address; away from home it uses the Tailscale name.

The phone keeps the token in the Android Keystore, so it is not stored in plain text. If you clear the phone's app data or reinstall the app, pair it again.

## Troubleshooting

- **"Not installed" in fisync:** Tailscale isn't on the computer. Complete Part 1, step 1.
- **"Installed but not running":** open Tailscale from the Start menu and sign in.
- **Phone can't find the computer nearby:** make sure both Bluetooth switches are on, you are within a few metres, and Nearby devices is allowed on the phone. On a Mac, check Bluetooth is allowed for the app in System Settings > Privacy & Security.
- **"Nearby Bluetooth on Linux needs one extra package":** run `npm install` in the fisync folder, then tick the option again.
- **Nothing works on a guest or work network:** some networks block devices from talking to each other. Tailscale usually still works, because it connects outward.
