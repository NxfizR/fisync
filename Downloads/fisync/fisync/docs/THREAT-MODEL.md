# Threat model

This document says what fisync protects, from whom, and where its protection stops.

## What is worth protecting

- **Files** in the shared folder, and files sent between devices.
- **Control** of the computer: the mouse, keyboard, and screen.
- **Calls, texts, contacts and photos** forwarded from the phone.
- **Clipboard** contents, which can contain passwords.
- **Keys**: the phone's link token, and the computer's stored pairing keys.

## Who might try

1. **Someone on the same Wi-Fi** (a neighbour, a guest, a compromised router).
2. **A nearby Bluetooth scanner.**
3. **The operator of a relay** you do not run yourself.
4. **A website** open in your browser, trying to reach fisync on localhost.
5. **A lost or stolen phone**, or someone who borrows it for a few minutes.
6. **A malicious or compromised app** on the phone, which can read notifications it is allowed to see.

## What fisync does about each

**Someone on the same network.** Every connection is encrypted end to end with keys created during pairing. Each connection uses fresh ephemeral keys, so recording traffic today does not reveal it later. A pairing needs the PIN and a click to approve on the computer. Traffic cannot be changed without the keys, and a changed packet ends the connection.

**Nearby Bluetooth.** The beacon carries an address and a seven-byte hash of the computer's ID, but no keys or names. The phone still needs the keys to connect. The beacon turns off after ten minutes unless turned on again.

**A relay operator.** The relay forwards bytes it cannot read. It learns the hash of each computer's ID, the times connections happen, and the network address of each client. Each computer's ID is random and long, so the relay cannot guess it. A relay can refuse to forward or delay traffic, but it cannot read, change or inject traffic, because the keys are not on the relay.

**A website on localhost.** Ports on the computer require the pairing key before anything is shared. A web page without the key cannot use them.

**A lost phone.** The phone's token is kept in the Android Keystore, which keeps the key in hardware where the device supports it. Each phone can be removed or have its key rotated from the computer. Phones lock after an hour of inactivity by default, and the computer can lock all remote access at once.

**A malicious app on the phone.** Notifications are forwarded only for apps the user chose. Each phone has its own permissions: files, control, screen, phone, and clipboard.

**File transfers.** Each upload carries a SHA-256 checksum, and a damaged file is refused.

**The desktop app.** Its windows are sandboxed, use an isolated script context, cannot open new windows, and cannot navigate away from fisync's own panel.

**Dependencies.** Every dependency version is locked in `package-lock.json`. GitHub Actions are pinned to commit hashes, and CodeQL and `npm audit` run on every change.

## What fisync does not protect against

- **Malware on the computer or the phone.** Anything that already runs with your permissions can read the files, see the keyboard and screen, or use the saved keys. fisync cannot stop that.
- **Someone with the phone unlocked** and time to use the app. Lock the phone and keep an eye on the list of paired phones.
- **A weak migration passphrase.** The migration file is only as strong as its passphrase. Use at least sixteen characters.
- **The activity log being rewritten.** The log chains each line to the one before, and links rotated files. Someone who can rewrite the whole folder can still rewrite the log. Keep the folder on a disk only you can write to.
- **Trust in the network path.** Tailscale and the relay see that you connect, and when. They do not see what you send.
- **The phone page in a browser.** The browser phone page stores its token in browser storage, which is weaker than the Android Keystore. Prefer the Android app for anything sensitive.
- **Unsigned installers.** The Windows installer is not yet code-signed, so Windows warns about it. Check the SHA-256 checksum in each release against `SHA256SUMS`.
- **No independent audit yet.** The encryption and pairing code has been tested, but no outside security firm has reviewed it. Treat fisync as a personal tool until one has.

## Known weaknesses being worked on

- Browser-based phones cannot rotate their keys yet.
- Nearby Bluetooth on Linux and macOS has not been tested on real hardware.
- The Android app's Keystore code and the relay's phone path have not been run on a real phone.
