#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Plugs Televo's audio device (TelevoAudioDevice: Apple voice processing +
/// rnnoise) and WebRTC field trials into react-native-webrtc before its
/// peer connection factory is created. Must run at app launch.
@interface TelevoAudioInstaller : NSObject

/// Installs unless the wearer turned the custom device off ("classic audio").
+ (void)installAtLaunch;

+ (BOOL)isInstalled;

/// Off restores WebRTC's stock audio device on the next app launch.
+ (BOOL)customDeviceEnabled;
+ (void)setCustomDeviceEnabled:(BOOL)enabled;

/// rnnoise on/off: immediate, and remembered.
+ (BOOL)noiseSuppressionEnabled;
+ (void)setNoiseSuppressionEnabled:(BOOL)enabled;

+ (NSDictionary<NSString *, id> *)diagnostics;

/// Loudness 0…1 for the call screen: the user's voice and the other side's.
/// 0 when the custom device isn't in use.
+ (float)microphoneLevel;
+ (float)speakerLevel;

@end

NS_ASSUME_NONNULL_END
