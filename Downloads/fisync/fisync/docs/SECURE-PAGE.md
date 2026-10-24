# The secure page (https)

fisync has two addresses on your computer:

- **The Android app address** (port 8484). The app connects here over your Wi-Fi. Everything sent is already encrypted by fisync.
- **The secure page address** (port 8443, https). Open this in a browser. The page itself is delivered over https, so nobody on the network can change it.

## Install the certificate once

Browsers only trust the secure page after you install fisync's certificate authority on the phone or computer. Do this once:

1. Open `http://<computer address>:8484/ca.pem` and save the file.
2. Check the fingerprint. The pairing window on the computer shows it under "Secure page". It must match exactly. If it does not, do not install the file.
3. Install it:
   - **Android:** Settings → Security (or "Security and privacy") → Encryption and credentials → Install a certificate → CA certificate. Choose the file.
   - **Windows:** double-click the file → Install certificate → Local Machine → place in "Trusted Root Certification Authorities".
   - **Linux (Chrome):** Settings → Privacy and security → Security → Manage certificates → Authorities → Import.
4. Open `https://<computer address>:8443`.

## Notes

- The fingerprint identifies the certificate authority, not the server. It stays the same. The server certificate is renewed automatically when the computer's address changes.
- The authority's private key is kept only on the computer, in `~/.fisync/tls/ca.key`. Anyone who gets that file could make certificates your phones would trust, so keep your user account secure and never copy that file elsewhere.
- Once installed, the authority is trusted for every address, not only fisync's. Remove it from the phone's certificate list if you stop using fisync.
- The Android app does not need this step.
