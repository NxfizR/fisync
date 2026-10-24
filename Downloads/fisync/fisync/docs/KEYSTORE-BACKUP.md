# Backing up the Android signing key

The Android key (the keystore file and its passwords) signs every release of the app. Phones only accept an update if it is signed with the same key as the version already installed. If the key is lost, you cannot update existing installs; users would have to uninstall and reinstall, losing their settings.

## What to keep

1. The keystore file `fisync-release.keystore`.
2. The keystore password, the key alias (`fisync`) and the key password.

## Where to keep it

- Two copies, in two different places (for example a password manager's file storage and an encrypted USB drive stored away from the computer).
- The passwords in a password manager, not in a file next to the keystore.
- Never commit the keystore to the repository. The repository ignores `*.keystore` files, and the key is stored as a GitHub secret for the build.

## Check the backup works

Once a year, check that the copy opens:

    keytool -list -keystore fisync-release.keystore -alias fisync

Enter the password. The command should print a certificate fingerprint. Compare it with the fingerprint printed in the previous check, and write the date next to it in your password manager.

## If the key is lost

Create a new key, tell your users that they must uninstall and reinstall, and publish the new signing fingerprint on the release page.
