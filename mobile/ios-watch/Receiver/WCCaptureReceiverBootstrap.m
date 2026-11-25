// SPDX-License-Identifier: AGPL-3.0-only
#import <Foundation/Foundation.h>
#import <objc/message.h>

// The Tauri iOS app has NO Swift AppDelegate — its entry is `main.mm` →
// `ffi::start_app()` → Rust, and the UIApplicationDelegate lives inside wry/tao
// (libapp.a). So there is no natural Swift launch hook to activate the phone-side
// WatchConnectivity receiver. This ObjC `+load` (the standard "run code at
// launch without owning the AppDelegate" technique used by many SDKs) starts the
// receiver singleton on the main queue shortly after launch.
//
// It resolves the Swift class by its fixed ObjC runtime name (set via
// `@objc(WCCaptureReceiver)` in WCCaptureReceiver.swift) so no `-Swift.h`
// bridging header / module-name assumption is needed.
//
// ⚠️ DEVICE-VERIFY (ios-watch/README.md): confirm `+load` fires in the Tauri
// app and the singleton activates a WCSession that receives `transferUserInfo`.
// If `+load` proves unreliable in the wry launch sequence, promote the receiver
// into a proper `tauri-plugin` iOS Swift package whose `load()` owns activation.
@interface MyneWCCaptureReceiverBootstrap : NSObject
@end

@implementation MyneWCCaptureReceiverBootstrap

+ (void)load {
    dispatch_async(dispatch_get_main_queue(), ^{
        Class cls = NSClassFromString(@"WCCaptureReceiver");
        if (cls == Nil) {
            return;
        }
        SEL shared = NSSelectorFromString(@"shared");
        if ([cls respondsToSelector:shared]) {
            ((id (*)(id, SEL))objc_msgSend)(cls, shared);
        }
    });
}

@end
