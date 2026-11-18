#!/bin/bash
# Builds the disposable dashboard trial APK and prints its path. Needs a JDK and
# ANDROID_HOME with build-tools and an android-36 platform. The signing key is
# generated in the private build directory and is never reused.
set -eu
: "${ANDROID_HOME:?Set ANDROID_HOME}"
tools="$ANDROID_HOME/build-tools/${ANDROID_BUILD_TOOLS:-36.0.0}"
platform="$ANDROID_HOME/platforms/android-36/android.jar"
root=$(mktemp -d)
mkdir -p "$root/src/test/canaveral/dashboardtrial" "$root/classes" "$root/dex"
cat > "$root/AndroidManifest.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="test.canaveral.dashboardtrial" android:versionCode="1" android:versionName="1.0">
  <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36" />
  <application android:label="Trial" android:hasCode="true">
    <activity android:name=".TrialActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
XML
cat > "$root/src/test/canaveral/dashboardtrial/TrialActivity.java" <<'JAVA'
package test.canaveral.dashboardtrial;

public final class TrialActivity extends android.app.Activity {
    @Override protected void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        android.widget.TextView label = new android.widget.TextView(this);
        label.setText("Canaveral dashboard install trial");
        label.setGravity(android.view.Gravity.CENTER);
        label.setTextColor(android.graphics.Color.BLACK);
        label.setBackgroundColor(android.graphics.Color.WHITE);
        label.setTextSize(24);
        setContentView(label);
    }
}
JAVA
javac --release 11 -classpath "$platform" -d "$root/classes" "$root/src/test/canaveral/dashboardtrial/TrialActivity.java"
"$tools/d8" --release --min-api 26 --lib "$platform" --output "$root/dex" "$root"/classes/test/canaveral/dashboardtrial/*.class
"$tools/aapt2" link -o "$root/unsigned.apk" -I "$platform" --manifest "$root/AndroidManifest.xml"
(cd "$root/dex" && zip -q -X "$root/unsigned.apk" classes.dex)
"$tools/zipalign" -P 16 -f 4 "$root/unsigned.apk" "$root/aligned.apk"
keytool -genkeypair -keystore "$root/trial.keystore" -storepass trialpass -keypass trialpass \
  -alias trial -keyalg RSA -keysize 2048 -validity 1 -dname "CN=Canaveral trial" >/dev/null 2>&1
"$tools/apksigner" sign --ks "$root/trial.keystore" --ks-pass pass:trialpass --out "$root/trial.apk" "$root/aligned.apk"
"$tools/apksigner" verify "$root/trial.apk"
echo "$root/trial.apk"
