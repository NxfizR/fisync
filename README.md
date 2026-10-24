# fisync

Control your computer from your phone, move files between your devices, and (on Android) use your computer for calls, text messages and photos, all over your local network or USB.

- **Phone as trackpad and keyboard** for your Windows or Linux computer.
- **Screen sharing:** see your computer's screen on your phone and tap to click on it.
- **File transfer both ways** through the `~/fisync` folder on the computer.
- **Pairing with approval:** a phone needs the PIN and an Allow click on the computer. Each phone gets its own key, and you can forget them all at once.
- **USB fallback:** use a cable with USB debugging when Wi-Fi is blocked.
- **Phone on your computer (Android):** calls, text messages and photos on the computer, with contact names. Runs as a background service with a notification. Call audio can be sent to the computer over Bluetooth.

See [PRIVACY.md](PRIVACY.md) for what is stored and what is not.

## Install

Download from the Releases page:

- Windows: the `.exe` installer
- Linux: the `.AppImage` (`chmod +x`, then run it)
- Android: the `.apk` (sideload it)

## Pair a phone

1. Start fisync on the computer. It shows a PIN and a QR code.
2. Scan the QR code with the phone, or open the address shown and enter the PIN.
3. Click **Allow** on the computer.

Each phone is approved once. To remove all of them, use **Forget all phones** in the menu.

## Call audio over Bluetooth

Fisync cannot route phone-call audio itself, so the computer has to be paired with the phone as a Bluetooth hands-free device:

1. On the phone, open Bluetooth settings (the Bluetooth button in the Android app opens them) and pair the computer.
2. Allow the computer to handle calls, and make sure its hands-free or telephony audio service is on.
3. During a call, switch the call audio to the computer from the phone's call screen.

Support depends on the computer and its Bluetooth adapter. Linux needs BlueZ with hands-free (HFP) enabled.

## Screen sharing

Turn it on from the menu (**Share screen with phones**) or the phone panel. The phone's **Screen** tab shows the computer's screen, and tapping the picture clicks at that spot. This copies the screen to your phone. It does not make a second, extended display. For an extended second screen, use a third-party app such as spacedesk or Duet Display, and check that it supports your computer and phone.

Screen sharing needs the desktop app. Linux Wayland sessions may block it.

## USB

1. Install Android platform-tools (`adb`) on the computer and add it to your PATH.
2. On the phone, turn on Developer options and USB debugging, then connect the cable and tap Allow.
3. On the computer, choose **Connect a phone over USB**, or run `node usb.js`.
4. On the phone, open `localhost:8484` in the browser, or tap **Use USB** in the Android app.

Run step 3 again after unplugging and reconnecting the cable.

## Run from source

    npm install
    npm start        # terminal mode, prints a PIN and QR code
    npm run app      # desktop app window

Needs Node 18 or newer. Mouse and keyboard control needs an X11 session on Linux.

## Build

    npm run dist                                  # desktop installer for your OS, into dist/
    cd android-app && npm install && npx cap add android && npx cap sync android && bash native/patch.sh
    cd android && ./gradlew assembleDebug         # APK, needs JDK 17 and the Android SDK

Pushing a tag such as `v1.0.0` builds everything on GitHub Actions and attaches it to a release.

## Notes

- Works on your local network or over USB. Wi-Fi traffic is not encrypted, so use trusted networks only.
- Phones paired before this version must be paired again.
- Some phone makers stop background apps aggressively. If fisync disconnects, set its battery use to Unrestricted. The service does not restart after a reboot; open the app again to start it.
- Controlling a phone from a computer is not supported; that needs native Android code or a tool like scrcpy.

## Security

- Each phone is approved once on the computer, and the PIN changes every 5 minutes and after each pairing.
- Everything except the static pages is encrypted end to end between the computer and each phone (see Encryption below).
- Remove one phone, or all of them, from the **Paired phones** menu. A phone can also remove itself with **Forget this phone** (browser) or **Forget this computer** (Android app).
- Files ending in executable types (for example .exe, .bat, .ps1, .sh) are refused. Uploads over 2 GB are refused.
- Screen sharing stops on its own when no phone is watching for 2 minutes, or 30 seconds after the last phone leaves.
- Every pairing, removal, and sharing change is written to `~/.fisync/activity.log`. Open it from the menu.
- fisync keeps running in the tray when its window is closed. Quit it from the tray or menu.

## Encryption

Pairing and every connection after it use the same protocol:

1. The phone and computer each create a fresh P-256 key pair and a random 16-byte nonce.
2. The phone sends its public key and nonce, with an identifier derived from its secret. The computer answers with its own public key and nonce, plus a proof that it knows the secret.
3. The phone checks that proof, then sends its own proof. Both sides now hold the same shared secret, from which HKDF-SHA256 derives separate keys for each direction.
4. Every message is sealed with AES-256-GCM, using a counter as the nonce, so nothing can be replayed or reordered unnoticed.

Pairing works the same way, with the PIN as the proof. The new phone's secret is sent back encrypted, so someone watching the network cannot read it, and cannot pass the PIN check without the PIN.

Limits:
- The phone's first load of the web page over Wi-Fi is not signed. Someone who can change that page could change what it does. Use the Android app, which bundles its code, on networks you do not trust.
- Someone watching the network can still see the time, length and destination of each connection.
- Phones paired before this version must be paired again.

## Access control

Each paired phone has its own permissions: files, mouse and keyboard, screen, calls and messages, and clipboard. Change them in the desktop app under **Paired phones**, or choose **Files only** for a phone that should only move files. Removing a permission disconnects that phone from the feature straight away.

## Inactivity

A phone that sits idle locks after one hour (set `FISYNC_IDLE_SECONDS` to change this). To reconnect, you approve it again on the computer. The Android service is not locked, because it has to stay connected in the background.

## Clipboard

Clipboard sync is off by default. When you turn it on from the menu or the phone panel, text copied on either device is sent to the other one. Only text is sent, up to 100,000 characters. Turn it off when you copy passwords.

## Alerts and network changes

Phones are told when screen sharing starts and when another phone is removed. fisync also notices when the computer's network address changes and shows a notice, so you can check you trust the new network. It cannot tell whether a Wi-Fi network is public.

## Transfer limits

Set `FISYNC_MAX_MBPS` to limit uploads and downloads, for example `FISYNC_MAX_MBPS=5` for 5 MB per second. The default is no limit.

## Drag and drop

Drag files onto the phone panel on the computer to send them to your phones. They appear in each phone's Files tab. Phones have no drag and drop, so use the Files tab's Choose files button there.

## Tests

`npm test` runs the server checks (access, clipboard, alerts, inactivity lock, transfer limits). They use a temporary folder and a test port, so they do not touch your files.

## Finding the computer again

The computer advertises itself on your local network with a public id (never a key). The Android app uses that id to find the computer again if its address changes, so you don't need to retype the address. Multicast is needed; some routers and guest Wi-Fi networks block it. In that case, type the address as before.

## Phone status and contacts

The phone panel shows the phone's battery, charging state and mobile network type. The contact search box finds contacts by name on the phone and fills in the number.

## Shortcuts

Phone panel: Alt+1, Alt+2 and Alt+3 switch tabs, / searches contacts, Esc leaves a conversation, and Ctrl+Enter sends a text. Desktop (from any app): Ctrl+Shift+M shares or stops sharing the screen, Ctrl+Shift+C turns clipboard sync on or off, and Ctrl+Shift+P opens the phone panel. On macOS use Cmd in place of Ctrl.

## Notifications and export

Incoming texts and ringing calls show a desktop notification; click it to open the phone panel. Calls and messages can be exported to CSV from the phone panel. Formula characters are quoted, so spreadsheets do not run them.

## Restart after a reboot

If the phone is paired, the background link starts again after it restarts. Android 15 and newer can block this start at boot; then open the app once to start it.

## Security at rest

The list of paired phones is encrypted on disk with a key that Windows (or the Linux keyring) protects for your account. If that key is lost, fisync cannot read the list and refuses to overwrite it; delete `~/.fisync/devices.json` to start again, then pair your phones again.

## Updates

The desktop app checks for new releases when it starts. Use **Check for updates** in the menu to check now. Updates come from this repo's Releases page.

## Testing

Every push runs the server tests on GitHub (the Tests workflow).

## Signing (optional)

To sign the Windows installer, add two repository secrets: `CSC_LINK` (your code-signing certificate, base64 or a file link) and `CSC_KEY_PASSWORD` (its password). Without them, the build is unsigned and Windows shows a warning.

## Languages

The phone page is available in all 24 official languages of the European Union: Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hungarian, Irish, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, Slovak, Slovene, Spanish and Swedish. It follows the browser's language and can be changed with the menu at the top of the page. Translations live in `public/i18n/` as one JSON file per language.

The translations were written without review by native speakers. Please have a native speaker check each file before a release. Phone panel, desktop menus, Android notifications and connection error messages are still in English.

## Lock

The phone panel and the desktop menu can lock the phones: remote control, the screen and file access stop until you unlock them. Calls and texts keep working. The computer also locks when it goes to sleep, so unlock from the menu when you are back.

## Notifications and replies

With notification access allowed on the phone, notifications from other apps appear on the computer. Texts from the phone can be answered from the desktop notification (Windows and macOS; Linux shows the notification without a reply box).

## Wake the computer

If the computer allows Wake-on-LAN and the phone is on the same Wi-Fi, the Android app can wake it. A computer that is fully asleep cannot run fisync, so the phone sends the wake signal and the computer then starts fisync when you open it.

## Several computers

The Android app keeps every computer you pair with. Pick one from the list at the top of the screen.

## Quick actions

Call the last number, reply to the last text with a template, and see the battery-saving behaviour: photo sync pauses below 20% battery unless the phone is charging.

## Crash reports

Errors on the computer and the phone are written to a file on that device only. Nothing is sent anywhere. Open or copy the report from the menu or the Android app, and clear it when you no longer need it.

## Release checks

Before a release is published, the build checks that the installers and the APK exist, are a reasonable size, and contain the parts the app needs.

## Secure page

Browsers connect to the secure page at `https://<computer address>:8443`. Install fisync's certificate once, after checking its fingerprint. See `docs/SECURE-PAGE.md`. The Android app keeps using the plain address on port 8484, which is already encrypted by fisync.

## Guides

- `docs/SECURE-PAGE.md`: installing the local certificate.
- `docs/RELEASE-SIGNING.md`: signing the Windows installer.
- `docs/KEYSTORE-BACKUP.md`: backing up the Android signing key.
- `docs/GOOGLE-PLAY.md`: what to check before publishing on Google Play.

## Translation review

`node scripts/i18n-review.js public/i18n review.csv` writes every translation next to its English text, with warnings for strings that may be too long, untranslated or missing a placeholder.

## License

fisync is released under the MIT License. See the LICENSE file.

## Everyday features

- **Connection light** on the phone page: green when connected, amber while reconnecting, red when the computer cannot be reached.
- **Settings on the phone page**: pointer speed, natural scrolling, vibration, sending each key as you type, and photo previews. Each is remembered on that phone.
- **Files on the phone page**: sort by name, date or size; filter; rename or delete a file on the computer (with a confirmation); resume an interrupted upload or download; see progress with speed and time left.
- **Phone panel**: search messages and recent calls; copy numbers and message text; date dividers in conversations; star favourite contacts; press ? for shortcuts; the panel remembers the last tab.
- **Pause**: stop phone access for an hour from the menu or the phone panel. It resumes on its own.
- **Do not disturb** on the desktop hides phone alerts without stopping them.
- **Clipboard history** shows whether each text came from the phone or this computer.
- **Last seen**: each phone's menu shows when it last connected.
- **Settings file**: export and import the computer's settings (photo sync schedule) when you move to a new computer. Paired phones are not moved; pair them again.
- **Battery** of a connected phone appears in the tray tooltip.
- The pairing window keeps its size and position, and includes a setup checklist.

## Data, trash and support

- Deleting a file from a phone moves it to a hidden trash folder inside the fisync folder. Empty the trash from the phone panel when you no longer need it.
- If a phone uploads a file whose name is taken, you choose: keep both, replace, or skip.
- Transfers are refused when they would leave less than 200 MB free on the computer.
- Synced photos can also be copied to a backup folder.
- Notifications from other apps are forwarded only for the apps you list in the phone panel.
- The phone panel's "Data and support" section shows what is stored, clears the activity log and crash report, empties the trash, and saves a diagnostics file. The diagnostics file leaves out keys, tokens and addresses, and hides phone names in the log.
- The activity log starts a new file at 5 MB; the previous one is kept as `activity.log.1`.
- Releases include a `SHA256SUMS` file so you can check each download. Dependabot checks npm and GitHub Actions weekly.

## Moving to a new computer

Under "Move to a new computer" in the phone panel, save a migration file protected by a passphrase of at least 12 characters. On the new computer, import the file. Your paired phones are added, and they connect to the new computer without pairing again. The new computer takes over the old computer's ID, so restart fisync once to finish. The secure-page certificate is not moved: reinstall the new computer's certificate on any device that uses the secure page. Delete the migration file once the move is done.

## Android

- The link notification has "Pause 1 hour" and "Lock computer" buttons.
- A Quick Settings tile pauses or resumes the phone link.
- A home-screen widget shows the link status.
- Long-pressing the app icon offers "Pause for an hour".
- The launcher warns when Android may stop fisync in the background and links to the battery settings.

## Remote access

- Tailscale: install on the computer and phone, sign in with the same account, then use the name shown under "Remote access" in the phone panel. Full steps are in [docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md).
- Nearby Bluetooth: tick the option under "Remote access" on Windows, and allow Nearby devices on the phone.

## Security

- [SECURITY.md](SECURITY.md): how to report a problem.
- [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md): what fisync protects against, and what it does not.
- [docs/RELAY.md](docs/RELAY.md): run your own relay.
