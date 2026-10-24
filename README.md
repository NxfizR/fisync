# Fisync

Control your computer from your phone, move files between your devices, and (on Android) use your computer for calls, text messages and photos, all over your local network or USB.

- **Phone as trackpad and keyboard** for your Windows or Linux computer.
- **Screen sharing:** see your computer's screen on your phone and tap to click on it.
- **File transfer both ways** through the `~/fisync` folder on the computer.
- **Pairing with approval:** a phone needs the PIN and an Allow click on the computer. Each phone gets its own key, and you can forget them all at once.
- **USB fallback:** use a cable with USB debugging when Wi-Fi is blocked.
- **Phone on your computer (Android):** calls, text messages and photos on the computer. Call audio stays on the phone.

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
- Controlling a phone from a computer is not supported; that needs native Android code or a tool like scrcpy.
