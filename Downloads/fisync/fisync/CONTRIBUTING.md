# Contributing to fisync

Thank you for helping. fisync connects your own devices, so careful changes matter more than fast ones.

## Set up

    npm install
    npm test            # runs every server test, using temporary folders
    npm run build:client   # only after changing src/

Node 18 or newer is needed. The Android app needs Android Studio's SDK, and the desktop app needs Electron, but neither is needed for the server tests.

## Where things are

- `server.js`: the computer side. Pairing, the encrypted channel, permissions, files, the activity log and the device list.
- `src/`: the browser client that both pages use. Changes here require `npm run build:client`, and the built file is committed.
- `public/`: the phone page, the phone panel, styles, and translations in `public/i18n/`.
- `main.js`: the desktop app (menus, tray, notifications, screen sharing).
- `android-app/native/`: the Android service, written in Kotlin.
- `test/`: the server tests.

## Before you open a pull request

1. Run `npm test`. Every suite must pass.
2. If you change the wire format, update `server.js`, `src/crypto-core.js`, `src/client.js` and `FiCrypto.kt` together, and add a test.
3. If you add a text on the phone page, add the key to every file in `public/i18n/`. The language test checks this.
4. Describe what you tested and on which system. Say clearly if you could not test something.

## Security

Please do not open a public issue for a security problem. Email the maintainer instead (see the README), and allow time for a fix before sharing details.
