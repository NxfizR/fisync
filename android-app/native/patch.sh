#!/usr/bin/env bash
# Run once after `npx cap add android`: adds the native plugin and the permissions it needs.
set -e
cd "$(dirname "$0")/.."
cp native/FiBridgePlugin.java native/MainActivity.java android/app/src/main/java/com/fisync/app/
M=android/app/src/main/AndroidManifest.xml
for p in CALL_PHONE READ_PHONE_STATE READ_CALL_LOG ANSWER_PHONE_CALLS READ_SMS SEND_SMS RECEIVE_SMS READ_MEDIA_IMAGES READ_EXTERNAL_STORAGE; do
  sed -i "s#</manifest>#    <uses-permission android:name=\"android.permission.$p\"/>\n</manifest>#" "$M"
done
