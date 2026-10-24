# Changelog

## Unreleased

### Phase 1 security and connection
- Phone link tokens are stored in the Android Keystore, not in browser or app preferences.
- Each computer keeps several addresses; the phone tries the next one when a connection fails.
- The pairing code includes the Tailscale name.
- The nearby Bluetooth beacon is a service ID, so no manufacturer registration is needed, and it turns itself off after 10 minutes.
- The phone listens for the beacon at most once every two minutes.
- The activity log records where the previous log file ended.
- Migration files use a stronger key-derivation setting; the desk panel shows a passphrase strength meter.

### Data and support
- Deleted files go to a trash folder; the trash can be emptied.
- Choice when a name is taken: keep both, replace, or skip.
- Transfers are refused when the disk would be left nearly full.
- Synced photos can be copied to a backup folder.
- Notifications are forwarded only for chosen apps.
- Data report, diagnostics file, and clear or empty actions.
- Activity log rotates at 5 MB.
- Release checksums and weekly dependency updates.
- Malformed-input test: the server stays up.
- Migration file: move paired phones to a new computer, protected by a passphrase.
- Phone can ask the computer to lock its remote access.
- Remote access: Tailscale name in the phone panel, and a nearby Bluetooth beacon (Windows, macOS and Linux computers; Android phone).
- Android: notification buttons (pause, lock), Quick Settings tile, home widget, long-press shortcut, battery settings check.

### Quality of life
- Connection light, settings and file tools on the phone page (sort, filter, rename, delete, resumable transfers, speed and time left, previews).
- Phone panel: search, copy buttons, date dividers, favourites, shortcut cheat sheet, pause control, remembered tab.
- Pause phone access for an hour; do not disturb on the desktop; battery in the tray tooltip.
- Clipboard history shows the source; each phone shows when it was last seen.
- Export and import of computer settings; remembered pairing window size and position; setup checklist.

### Project
- Released under the MIT License.

### Batch C
- Secure page for browsers over https, with a local certificate authority whose fingerprint is shown on the computer.
- Server certificate renews automatically when the network changes.
- Translation review sheet for native speakers.
- Guides for the secure page, Windows signing, Android key backup and Google Play.

### Batch B
- Notifications from other apps can be shown on the computer, after you allow notification access on the phone.
- Texts can be answered from the computer's notification.
- Phones are locked when the computer sleeps, and from the menu or phone panel.
- Wake-on-LAN from the Android app.
- Several computers in the Android app.
- Quick actions on the phone: call the last number, reply to the last text with a template.
- Scheduled photo sync from the phone, paused below 20% battery.
- Crash reports kept on each device, shown on request.
- Release files are checked before a release is published.

### Security
- Each phone is approved once and has its own key. Keys are never stored, only derived verification values.
- Everything except the static pages is encrypted: pairing, control, screen, messages, calls, photos and files.
- The paired-phone list is encrypted on disk with a key kept by Windows or the Linux keyring.
- Phones can be given fewer permissions, such as files only, and lock after an hour of inactivity.
- The phone panel key can be rotated from the menu.
- The activity log is tamper-evident: each line carries a hash of the line before it.
- Clipboard text that looks like a password or card number is not synced.
- The device list keeps a backup of the last good copy and restores from it if the main file is damaged.

### Phone features
- Calls, texts, photos and files, with contact names.
- Background service that keeps the link alive, reconnects, and starts again after a restart (where Android allows it).
- Screen sharing, trackpad and keyboard, and clipboard sync (off by default).
- Battery and network status, contact search, and CSV export of calls and messages.
- The phone page is available in all 24 official languages of the European Union, with a light and dark theme.

### Computer features
- Desktop app with a tray icon, menus, notifications for texts and calls, and global shortcuts.
- Clipboard history, automatic updates, and the phone panel.

### Release and testing
- Tests run on every push. Releases are built from version tags.
- Desktop installers are signed when signing secrets are provided.
