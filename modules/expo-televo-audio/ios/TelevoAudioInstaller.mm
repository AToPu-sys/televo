#import "TelevoAudioInstaller.h"

#import "TelevoAudioDevice.h"
#import "WebRTCModuleOptions.h"

static NSString *const kCustomDeviceKey = @"televo.audio.customDevice";
static NSString *const kNoiseSuppressionKey = @"televo.audio.noiseSuppression";
static TelevoAudioDevice *gDevice = nil;

@implementation TelevoAudioInstaller

+ (void)initialize {
  if (self == [TelevoAudioInstaller class]) {
    [NSUserDefaults.standardUserDefaults registerDefaults:@{kCustomDeviceKey : @YES, kNoiseSuppressionKey : @YES}];
  }
}

+ (void)installAtLaunch {
  WebRTCModuleOptions *options = [WebRTCModuleOptions sharedInstance];

  // RED (RFC 2198) for Opus: each packet also carries the previous one, so a
  // single lost packet costs nothing audible. Both phones run this build, so
  // both offer "red/48000/2" and it is negotiated.
  NSMutableDictionary *trials = [options.fieldTrials mutableCopy] ?: [NSMutableDictionary dictionary];
  trials[@"WebRTC-Audio-Red-For-Opus"] = @"Enabled";
  options.fieldTrials = trials;

  if (![self customDeviceEnabled]) {
    NSLog(@"[TelevoAudio] classic WebRTC audio (custom device turned off)");
    return;
  }
  NSBundle *bundle = [NSBundle bundleForClass:[TelevoAudioDevice class]];
  NSURL *resources = [bundle URLForResource:@"TelevoAudioResources" withExtension:@"bundle"];
  NSBundle *resourceBundle = resources ? [NSBundle bundleWithURL:resources] : bundle;
  NSURL *weightsURL = [resourceBundle URLForResource:@"rnnoise_weights" withExtension:@"bin"];
  NSData *weights = weightsURL ? [NSData dataWithContentsOfURL:weightsURL options:NSDataReadingMappedIfSafe error:nil] : nil;
  if (!weights) {
    NSLog(@"[TelevoAudio] rnnoise weights missing, keeping WebRTC's stock audio");
    return;
  }
  gDevice = [[TelevoAudioDevice alloc] initWithWeights:weights];
  gDevice.noiseSuppressionEnabled = [NSUserDefaults.standardUserDefaults boolForKey:kNoiseSuppressionKey];
  options.audioDevice = gDevice;
}

+ (BOOL)isInstalled {
  return gDevice != nil;
}

+ (BOOL)customDeviceEnabled {
  return [NSUserDefaults.standardUserDefaults boolForKey:kCustomDeviceKey];
}

+ (void)setCustomDeviceEnabled:(BOOL)enabled {
  [NSUserDefaults.standardUserDefaults setBool:enabled forKey:kCustomDeviceKey];
}

+ (BOOL)noiseSuppressionEnabled {
  return gDevice ? gDevice.noiseSuppressionEnabled : [NSUserDefaults.standardUserDefaults boolForKey:kNoiseSuppressionKey];
}

+ (void)setNoiseSuppressionEnabled:(BOOL)enabled {
  [NSUserDefaults.standardUserDefaults setBool:enabled forKey:kNoiseSuppressionKey];
  gDevice.noiseSuppressionEnabled = enabled;
}

+ (float)microphoneLevel {
  return gDevice.microphoneLevel;
}

+ (float)speakerLevel {
  return gDevice.speakerLevel;
}

+ (NSDictionary<NSString *, id> *)diagnostics {
  return @{
    @"customDevice" : @(gDevice != nil),
    @"noiseSuppression" : @(gDevice.noiseSuppressionEnabled),
    @"unitRunning" : @(gDevice.isUnitRunning),
    @"voiceProbability" : @(gDevice.voiceProbability),
  };
}

@end
