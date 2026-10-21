# Privacy Policy

Effective: October 21, 2026

fisync lets you control your computer from your phone, move files between your own devices, and (on Android) share calls, text messages and photos with your computer. This policy explains what happens to your data.

**In short:** fisync sends nothing to me or anyone else. There is no account, no server run by me, no analytics, no ads and no tracking. Your data moves between your own devices only.

## What fisync handles, and where it stays

- **Files.** Files you send or receive are saved in the `fisync` folder in your home folder on the computer. They stay there until you delete them.
- **Paired phones.** When you approve a phone, the computer saves its name, the date, and a one-way hash of its access key in `~/.fisync/devices.json`. The phone keeps the access key in its browser or app storage. The computer does not keep the key itself. Removing a phone deletes its entry.
- **The PIN.** A random 6-digit PIN is made each time fisync starts and changes after every pairing. It is kept in memory only.
- **Wrong PIN attempts.** To limit guessing, the computer briefly blocks an address after five wrong PINs. This is kept in memory only.
- **Computer panel access.** The phone panel on the computer uses a key that exists only in the fisync window and is kept in the browser session on that computer.
- **Calls, text messages and call log (Android app).** While the app is connected, these are read from your phone and passed to your computer so you can see and act on them. They are shown on screen and are not saved by fisync. Call audio never leaves the phone.
- **Photos (Android app).** The most recent photos you sync are copied into the `fisync` folder on the computer.
- **Screen sharing.** While you turn it on, the computer's screen is sent as pictures to phones that are paired and watching. Pictures are kept in memory only and are not saved. Turn sharing off from the menu or the phone panel.
- **Mouse, keyboard and typed text.** Sent from your phone and carried out on your computer. Not stored or logged.

## What I collect

Nothing. I do not receive or have access to your files, messages, calls, photos, screen, PIN, keys or network addresses.

## Permissions

- **Android app:** network access; read and send text messages; read the call log and phone state; place and answer calls; read photos. Each is used only for the feature it supports, and you can turn any of them off in Android settings, which disables that feature. It does not ask for contacts, location, camera or microphone.
- **Computer:** screen capture and input control, which the operating system may ask you to allow.

## Networks and encryption

On Wi-Fi, fisync uses plain HTTP and WebSocket connections, which are not encrypted. Anyone on the same network could in principle see or interfere with the traffic, including messages, photos, screen pictures and access keys. Use Wi-Fi only on networks you trust, never public Wi-Fi. The USB connection (see the README) sends traffic over the cable instead of the network.

## Third parties

fisync does not send data to any third party and has no analytics or advertising code. Downloads from GitHub are subject to GitHub's own policies.

## Children

fisync is not directed at children and does not knowingly collect personal information from anyone.

## Your control

Delete the files in the `fisync` folder at any time. Use "Forget all phones" in the menu, or `node server.js --forget`, to remove every paired phone. Close the app to stop screen sharing and clear the PIN. Uninstall it to remove the app, and delete `~/.fisync` to remove the paired-device list. Because I hold no data about you, there is nothing for me to export or erase.

## Changes

If this policy changes, the new version will be posted in this file with an updated date.

## Contact

[your name or email], or open an issue at https://github.com/[your-username]/fisync/issues
