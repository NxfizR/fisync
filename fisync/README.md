# fisync

Control your computer from your phone and move files between your devices over your local network.

- **Phone as trackpad and keyboard** for your Windows or Linux computer (mouse, scroll, typing, volume and media keys).
- **File transfer both ways** through a shared `~/fisync` folder on the computer.
- **Phone on your computer (Android):** see calls, text messages and photos on the computer at `/desk`, and place or answer calls and send texts from it. Call audio stays on the phone.
- **Pairing** with a random PIN and a QR code, shown on the computer each time it starts.

## Install

Download from the Releases page:

- Windows: the `.exe` installer
- Linux: the `.AppImage` (`chmod +x`, then run it)
- Android: the `.apk` (sideload it). It asks for your computer's address and PIN, then shares calls, messages and photos with the computer while it stays open.

## Run from source

    npm install
    npm start        # terminal mode, prints a QR code
    npm run app      # desktop window

Needs Node 18 or newer. On Linux, mouse and keyboard control needs an X11 session.

## Build

    npm run dist                                  # desktop installer for your OS, into dist/
    cd android-app && npm install && npx cap add android && npx cap sync android && bash native/patch.sh
    cd android && ./gradlew assembleDebug         # APK, needs JDK 17 and the Android SDK

Pushing a tag such as `v1.0.0` builds everything on GitHub Actions and attaches it to a release.

## Notes

- Works on your local network only, over plain HTTP. Don't use it on public Wi-Fi.
- Anyone with the PIN can control the computer. The PIN changes every time fisync starts.
- Controlling a phone from a computer is not supported; that needs native Android code or a tool like scrcpy.
- Read the [privacy policy](PRIVACY.md) for what fisync does with your data.
