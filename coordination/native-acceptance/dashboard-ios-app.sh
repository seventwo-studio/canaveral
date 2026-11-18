#!/bin/bash
set -eu
: "${DEVELOPER_DIR:?Select Xcode}"
root=$(mktemp -d)
app="$root/Trial.app"
mkdir "$app"
cat > "$app/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>test.canaveral.dashboardtrial</string>
<key>CFBundleExecutable</key><string>Trial</string>
<key>CFBundleName</key><string>Trial</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>MinimumOSVersion</key><string>17.0</string>
<key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
<key>UIApplicationSceneManifest</key><dict>
<key>UIApplicationSupportsMultipleScenes</key><false/>
<key>UISceneConfigurations</key><dict><key>UIWindowSceneSessionRoleApplication</key><array><dict>
<key>UISceneConfigurationName</key><string>Default</string>
<key>UISceneDelegateClassName</key><string>TrialSceneDelegate</string>
</dict></array></dict></dict>
</dict></plist>
PLIST
cat > "$root/main.m" <<'OBJC'
#import <UIKit/UIKit.h>
// iOS 27 traps apps that do not adopt the scene lifecycle.
@interface TrialDelegate : UIResponder <UIApplicationDelegate>
@end
@implementation TrialDelegate
@end
@interface TrialSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(strong, nonatomic) UIWindow *window;
@end
@implementation TrialSceneDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
    UIViewController *controller = [UIViewController new];
    UILabel *label = [[UILabel alloc] initWithFrame:self.window.bounds];
    label.text = @"Canaveral dashboard install trial";
    label.textAlignment = NSTextAlignmentCenter;
    controller.view = label;
    self.window.rootViewController = controller;
    [self.window makeKeyAndVisible];
}
@end
int main(int argc, char **argv) {
    @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(TrialDelegate.class)); }
}
OBJC
xcrun --sdk iphonesimulator clang -target arm64-apple-ios17.0-simulator -fobjc-arc -framework UIKit -framework Foundation "$root/main.m" -o "$app/Trial"
codesign --force --sign - "$app"
COPYFILE_DISABLE=1 tar --format ustar -cf "$root/Trial.app.tar" -C "$root" Trial.app
echo "$root/Trial.app.tar"
