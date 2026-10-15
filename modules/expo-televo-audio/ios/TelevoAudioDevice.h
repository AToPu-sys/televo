#import <Foundation/Foundation.h>
#import <WebRTC/RTCAudioDevice.h>

NS_ASSUME_NONNULL_BEGIN

/// WebRTC's microphone and speaker for calls, replacing the built-in audio
/// device module so the microphone signal can be cleaned before it is
/// encoded — the same design as Telegram's tgcalls, which also ships its own
/// audio device.
///
/// One VoiceProcessingIO unit does both directions, so Apple's echo
/// cancellation and gain control still run; rnnoise then removes the
/// background noise Apple's processing leaves (traffic, wind, crowds, fans).
@interface TelevoAudioDevice : NSObject <RTCAudioDevice>

/// rnnoise on or off; takes effect within 10 ms, mid-call.
@property(atomic) BOOL noiseSuppressionEnabled;
/// Last frame's voice probability, 0…1.
@property(readonly) float voiceProbability;
/// The unit is running (diagnostics).
@property(readonly) BOOL isUnitRunning;

- (instancetype)initWithWeights:(NSData *)weights NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

@end

NS_ASSUME_NONNULL_END
