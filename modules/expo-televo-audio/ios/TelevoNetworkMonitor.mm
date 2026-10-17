#import "TelevoNetworkMonitor.h"

#import <Network/Network.h>

#include <mutex>
#include <string>

namespace {

/// One snapshot of the path. `signature()` is what decides whether an update is
/// a real change: nw_path_monitor also fires for things a call doesn't care
/// about, and every restart costs a renegotiation, so only a different
/// interface, status, cost class or gateway counts.
struct PathState {
  std::string status = "unknown";
  std::string interface = "none";
  std::string gateway;
  bool expensive = false;
  bool constrained = false;
  bool ipv4 = false;
  bool ipv6 = false;

  std::string signature() const {
    return status + "|" + interface + "|" + gateway + "|" + (expensive ? "e" : "-") + (constrained ? "c" : "-") +
           (ipv4 ? "4" : "-") + (ipv6 ? "6" : "-");
  }

  NSDictionary<NSString *, id> *dictionary() const {
    return @{
      @"status" : [NSString stringWithUTF8String:status.c_str()],
      @"interface" : [NSString stringWithUTF8String:interface.c_str()],
      @"gateway" : [NSString stringWithUTF8String:gateway.c_str()],
      @"expensive" : @(expensive),
      @"constrained" : @(constrained),
      @"ipv4" : @(ipv4),
      @"ipv6" : @(ipv6),
    };
  }
};

PathState readPath(nw_path_t path) {
  PathState state;
  switch (nw_path_get_status(path)) {
    case nw_path_status_satisfied: state.status = "satisfied"; break;
    case nw_path_status_unsatisfied: state.status = "unsatisfied"; break;
    case nw_path_status_satisfiable: state.status = "satisfiable"; break;
    default: state.status = "unknown"; break;
  }
  if (nw_path_uses_interface_type(path, nw_interface_type_wifi)) state.interface = "wifi";
  else if (nw_path_uses_interface_type(path, nw_interface_type_cellular)) state.interface = "cellular";
  else if (nw_path_uses_interface_type(path, nw_interface_type_wired)) state.interface = "wired";
  else if (nw_path_uses_interface_type(path, nw_interface_type_other)) state.interface = "other";
  state.expensive = nw_path_is_expensive(path);
  state.constrained = nw_path_is_constrained(path);
  state.ipv4 = nw_path_has_ipv4(path);
  state.ipv6 = nw_path_has_ipv6(path);
  // The first gateway tells two Wi-Fi networks apart (same interface type,
  // different router) — the home -> office handover case.
  __block std::string gateway;
  nw_path_enumerate_gateways(path, ^bool(nw_endpoint_t endpoint) {
    const char *host = nw_endpoint_get_hostname(endpoint);
    if (host) gateway = host;
    else {
      char *description = nw_endpoint_copy_address_string(endpoint);
      if (description) {
        gateway = description;
        free(description);
      }
    }
    return false;  // first one is enough
  });
  state.gateway = gateway;
  return state;
}

}  // namespace

@implementation TelevoNetworkMonitor {
  nw_path_monitor_t _monitor;
  dispatch_queue_t _queue;
  TelevoNetworkChangeHandler _handler;
  std::mutex _lock;
  PathState _last;
  std::string _lastSignature;
}

+ (instancetype)shared {
  static TelevoNetworkMonitor *instance;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ instance = [TelevoNetworkMonitor new]; });
  return instance;
}

- (instancetype)init {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("televo.network-monitor", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)startWithHandler:(TelevoNetworkChangeHandler)handler {
  {
    std::lock_guard<std::mutex> guard(_lock);
    _handler = [handler copy];
    if (_monitor) return;
  }
  nw_path_monitor_t monitor = nw_path_monitor_create();
  nw_path_monitor_set_queue(monitor, _queue);
  __weak TelevoNetworkMonitor *weakSelf = self;
  nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
    TelevoNetworkMonitor *strongSelf = weakSelf;
    if (!strongSelf) return;
    [strongSelf handlePath:path];
  });
  {
    std::lock_guard<std::mutex> guard(_lock);
    _monitor = monitor;
  }
  nw_path_monitor_start(monitor);
}

- (void)handlePath:(nw_path_t)path {
  PathState state = readPath(path);
  std::string signature = state.signature();
  TelevoNetworkChangeHandler handler;
  {
    std::lock_guard<std::mutex> guard(_lock);
    if (signature == _lastSignature) return;
    _lastSignature = signature;
    _last = state;
    handler = _handler;
  }
  if (handler) handler(state.dictionary());
}

- (void)stop {
  nw_path_monitor_t monitor;
  {
    std::lock_guard<std::mutex> guard(_lock);
    monitor = _monitor;
    _monitor = nil;
    _handler = nil;
    _lastSignature.clear();
  }
  if (monitor) nw_path_monitor_cancel(monitor);
}

- (NSDictionary<NSString *, id> *)currentPath {
  std::lock_guard<std::mutex> guard(_lock);
  return _last.dictionary();
}

@end
