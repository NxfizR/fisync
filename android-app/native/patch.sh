#!/usr/bin/env bash
# Run after `npx cap add android` and `npx cap sync android`.
set -e
cd "$(dirname "$0")/.."
SRC=android/app/src/main
PKG=$SRC/java/com/fisync/app
mkdir -p "$PKG"
rm -f "$PKG/MainActivity.java"          # Capacitor generates a Java MainActivity; ours is Kotlin
cp native/*.kt "$PKG"/
cp native/signing.gradle android/app/signing.gradle

# Kotlin support in the Gradle build
ROOT=android/build.gradle
grep -q kotlin-gradle-plugin "$ROOT" || sed -i '/com.android.tools.build:gradle/a\        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.22"' "$ROOT"
G=android/app/build.gradle
grep -q "kotlin-android" "$G" || sed -i "/apply plugin: 'com.android.application'/a apply plugin: 'kotlin-android'" "$G"
grep -q okhttp "$G" || sed -i '/^dependencies {/a\    implementation "com.squareup.okhttp3:okhttp:4.12.0"' "$G"
grep -q signing.gradle "$G" || echo 'apply from: "signing.gradle"' >> "$G"
grep -q work-runtime "$G" || sed -i '/^dependencies {/a\    implementation "androidx.work:work-runtime:2.9.0"' "$G"

M=$SRC/AndroidManifest.xml
for p in CALL_PHONE READ_PHONE_STATE READ_CALL_LOG ANSWER_PHONE_CALLS READ_SMS SEND_SMS RECEIVE_SMS \
         READ_CONTACTS READ_MEDIA_IMAGES READ_EXTERNAL_STORAGE POST_NOTIFICATIONS \
         FOREGROUND_SERVICE FOREGROUND_SERVICE_DATA_SYNC CAMERA BLUETOOTH_SCAN BLUETOOTH_CONNECT ACCESS_FINE_LOCATION; do
  grep -q "permission.$p\"" "$M" || sed -i "s#</manifest>#    <uses-permission android:name=\"android.permission.$p\"/>\n</manifest>#" "$M"
done
grep -q 'usesCleartextTraffic' "$M" || sed -i 's#<application#<application android:usesCleartextTraffic="true"#' "$M"
grep -q 'BridgeService' "$M" || sed -i 's#</application>#    <service android:name="com.fisync.app.BridgeService" android:exported="false" android:foregroundServiceType="dataSync"/>\n</application>#' "$M"
grep -q 'BootReceiver' "$M" || sed -i 's#</application>#    <receiver android:name="com.fisync.app.BootReceiver" android:exported="true"><intent-filter><action android:name="android.intent.action.BOOT_COMPLETED"/><action android:name="android.intent.action.MY_PACKAGE_REPLACED"/></intent-filter></receiver>\n</application>#' "$M"

grep -q 'NotifListener' "$M" || sed -i 's#</application>#    <service android:name="com.fisync.app.NotifListener" android:exported="true" android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"><intent-filter><action android:name="android.service.notification.NotificationListenerService"/></intent-filter></service>\n</application>#' "$M"
RES=$SRC/res
mkdir -p "$RES/layout" "$RES/xml"
cp native/res/layout/*.xml "$RES/layout/"
cp native/res/xml/*.xml "$RES/xml/"
grep -q 'ControlReceiver' "$M" || sed -i 's#</application>#    <receiver android:name="com.fisync.app.ControlReceiver" android:exported="false"><intent-filter><action android:name="com.fisync.PAUSE"/><action android:name="com.fisync.LOCK"/></intent-filter></receiver>\n</application>#' "$M"
grep -q 'PauseTile' "$M" || sed -i 's#</application>#    <service android:name="com.fisync.app.PauseTile" android:label="fisync" android:icon="@mipmap/ic_launcher" android:exported="true" android:permission="android.permission.BIND_QUICK_SETTINGS_TILE"><intent-filter><action android:name="android.service.quicksettings.action.QS_TILE"/></intent-filter></service>\n</application>#' "$M"
grep -q 'FisyncWidget' "$M" || sed -i 's#</application>#    <receiver android:name="com.fisync.app.FisyncWidget" android:exported="true" android:label="fisync"><intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE"/></intent-filter><meta-data android:name="android.appwidget.provider" android:resource="@xml/widget_info"/></receiver>\n</application>#' "$M"
echo "Kotlin sources, Gradle setup, permissions, service, OkHttp and release signing added."
echo "Notification buttons, Quick Settings tile, home widget and battery settings added."

