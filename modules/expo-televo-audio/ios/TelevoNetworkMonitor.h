#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^TelevoNetworkChangeHandler)(NSDictionary<NSString *, id> *path);

/// Watches the device's network path (Network.framework's nw_path_monitor) and
/// reports every real change — Wi-Fi <-> cellular, a different Wi-Fi network,
/// losing or regaining connectivity — so a call can restart ICE the moment the
/// route under it changes, instead of waiting for WebRTC to notice the old one
/// has gone silent.
@interface TelevoNetworkMonitor : NSObject

+ (instancetype)shared;

/// Starts monitoring (or replaces the handler if already running). The handler
/// runs on a private serial queue, once per distinct path.
- (void)startWithHandler:(TelevoNetworkChangeHandler)handler;
- (void)stop;

/// The last path seen: status, interface, expensive, constrained, ipv4, ipv6,
/// gateway. Empty-ish ("unknown") before the first update.
- (NSDictionary<NSString *, id> *)currentPath;

@end

NS_ASSUME_NONNULL_END
