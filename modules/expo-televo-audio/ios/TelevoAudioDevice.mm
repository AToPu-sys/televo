#import "TelevoAudioDevice.h"

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>

#include <atomic>
#include <memory>

#include "TelevoNoiseSuppressor.h"
#include "rnnoise.h"

static const double kSampleRate = 48000.0;
static const UInt32 kMaxFrames = 8192;

/// Everything the real-time callbacks touch, in one plain struct: no
/// Objective-C messaging and no allocation on the audio thread.
struct TelevoAudioContext {
  AudioUnit unit = nullptr;
  std::atomic<bool> playing{false};
  std::atomic<bool> recording{false};
  int16_t inputSamples[kMaxFrames];
  std::unique_ptr<televo::NoiseSuppressor> suppressor;
  RTCAudioDeviceDeliverRecordedDataBlock deliver = nil;
  RTCAudioDeviceGetPlayoutDataBlock playout = nil;
};

static OSStatus TelevoInputCallback(void *refCon, AudioUnitRenderActionFlags *flags,
                                    const AudioTimeStamp *timestamp, UInt32 bus, UInt32 frames,
                                    AudioBufferList * /*unused*/) {
  auto *ctx = static_cast<TelevoAudioContext *>(refCon);
  if (frames > kMaxFrames || !ctx->unit) return kAudioUnitErr_TooManyFramesToProcess;

  AudioBufferList list;
  list.mNumberBuffers = 1;
  list.mBuffers[0].mNumberChannels = 1;
  list.mBuffers[0].mDataByteSize = frames * sizeof(int16_t);
  list.mBuffers[0].mData = ctx->inputSamples;
  OSStatus status = AudioUnitRender(ctx->unit, flags, timestamp, bus, frames, &list);
  if (status != noErr) return status;
  if (!ctx->recording.load(std::memory_order_relaxed)) return noErr;

  if (ctx->suppressor) ctx->suppressor->process(ctx->inputSamples, frames);
  RTCAudioDeviceDeliverRecordedDataBlock deliver = ctx->deliver;
  return deliver ? deliver(flags, timestamp, bus, frames, &list, nullptr, nil) : noErr;
}

static OSStatus TelevoRenderCallback(void *refCon, AudioUnitRenderActionFlags *flags,
                                     const AudioTimeStamp *timestamp, UInt32 bus, UInt32 frames,
                                     AudioBufferList *data) {
  auto *ctx = static_cast<TelevoAudioContext *>(refCon);
  RTCAudioDeviceGetPlayoutDataBlock playout = ctx->playout;
  if (ctx->playing.load(std::memory_order_relaxed) && playout) {
    return playout(flags, timestamp, bus, frames, data);
  }
  for (UInt32 i = 0; i < data->mNumberBuffers; i++) {
    memset(data->mBuffers[i].mData, 0, data->mBuffers[i].mDataByteSize);
  }
  *flags |= kAudioUnitRenderAction_OutputIsSilence;
  return noErr;
}

@implementation TelevoAudioDevice {
  NSData *_weights;
  RNNModel *_model;
  TelevoAudioContext *_ctx;
  id<RTCAudioDeviceDelegate> _delegate;
  BOOL _initialized;
  BOOL _playoutInitialized;
  BOOL _recordingInitialized;
  BOOL _unitRunning;
  NSInteger _startAttempt;
}

- (instancetype)initWithWeights:(NSData *)weights {
  if ((self = [super init])) {
    // rnnoise keeps pointers into the blob, so the data must stay alive.
    _weights = weights;
    _model = rnnoise_model_from_buffer(_weights.bytes, (int)_weights.length);
    _ctx = new TelevoAudioContext();
    if (_model) _ctx->suppressor = std::make_unique<televo::NoiseSuppressor>(_model);
    NSLog(@"[TelevoAudio] rnnoise model %@", _model ? @"loaded" : @"FAILED to load, calls run without it");

    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserver:self selector:@selector(handleInterruption:)
                   name:AVAudioSessionInterruptionNotification object:nil];
    [center addObserver:self selector:@selector(handleMediaServicesReset:)
                   name:AVAudioSessionMediaServicesWereResetNotification object:nil];
  }
  return self;
}

- (void)dealloc {
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [self disposeUnit];
  delete _ctx;
  if (_model) rnnoise_model_free(_model);
}

#pragma mark - Noise suppression switch

- (BOOL)noiseSuppressionEnabled {
  return _ctx->suppressor && _ctx->suppressor->enabled.load();
}

- (void)setNoiseSuppressionEnabled:(BOOL)enabled {
  if (_ctx->suppressor) _ctx->suppressor->enabled.store(enabled);
}

- (float)voiceProbability {
  return _ctx->suppressor ? _ctx->suppressor->lastVoiceProbability.load() : 0;
}

- (BOOL)isUnitRunning {
  return _unitRunning;
}

#pragma mark - RTCAudioDevice: formats

// The unit's client side is fixed at 48 kHz mono 16-bit; VoiceProcessingIO
// converts to and from whatever the hardware runs at, so the format WebRTC
// sees never changes when the route moves between iPhone, speaker and AirPods.
- (double)deviceInputSampleRate { return kSampleRate; }
- (double)deviceOutputSampleRate { return kSampleRate; }
- (NSInteger)inputNumberOfChannels { return 1; }
- (NSInteger)outputNumberOfChannels { return 1; }
- (NSTimeInterval)inputIOBufferDuration { return AVAudioSession.sharedInstance.IOBufferDuration; }
- (NSTimeInterval)outputIOBufferDuration { return AVAudioSession.sharedInstance.IOBufferDuration; }
- (NSTimeInterval)inputLatency { return AVAudioSession.sharedInstance.inputLatency; }
- (NSTimeInterval)outputLatency { return AVAudioSession.sharedInstance.outputLatency; }

#pragma mark - RTCAudioDevice: lifecycle

- (BOOL)isInitialized { return _initialized; }
- (BOOL)isPlayoutInitialized { return _playoutInitialized; }
- (BOOL)isRecordingInitialized { return _recordingInitialized; }
- (BOOL)isPlaying { return _ctx->playing.load(); }
- (BOOL)isRecording { return _ctx->recording.load(); }

- (BOOL)initializeWithDelegate:(id<RTCAudioDeviceDelegate>)delegate {
  _delegate = delegate;
  _ctx->deliver = delegate.deliverRecordedData;
  _ctx->playout = delegate.getPlayoutData;
  _initialized = YES;
  return YES;
}

- (BOOL)terminateDevice {
  _ctx->playing = false;
  _ctx->recording = false;
  [self disposeUnit];
  _ctx->deliver = nil;
  _ctx->playout = nil;
  _delegate = nil;
  _initialized = NO;
  _playoutInitialized = NO;
  _recordingInitialized = NO;
  return YES;
}

- (BOOL)initializePlayout {
  _playoutInitialized = [self createUnitIfNeeded];
  return _playoutInitialized;
}

- (BOOL)initializeRecording {
  _recordingInitialized = [self createUnitIfNeeded];
  return _recordingInitialized;
}

- (BOOL)startPlayout {
  _ctx->playing = true;
  [self startUnitIfNeeded];
  return YES;
}

- (BOOL)stopPlayout {
  _ctx->playing = false;
  [self stopUnitIfIdle];
  return YES;
}

- (BOOL)startRecording {
  _ctx->recording = true;
  [self startUnitIfNeeded];
  return YES;
}

- (BOOL)stopRecording {
  _ctx->recording = false;
  [self stopUnitIfIdle];
  return YES;
}

#pragma mark - The VoiceProcessingIO unit

- (BOOL)createUnitIfNeeded {
  if (_ctx->unit) return YES;
  AudioComponentDescription description = {
      kAudioUnitType_Output, kAudioUnitSubType_VoiceProcessingIO, kAudioUnitManufacturer_Apple, 0, 0};
  AudioComponent component = AudioComponentFindNext(nullptr, &description);
  AudioUnit unit = nullptr;
  if (!component || AudioComponentInstanceNew(component, &unit) != noErr) {
    NSLog(@"[TelevoAudio] could not create the voice processing unit");
    return NO;
  }

  UInt32 one = 1;
  UInt32 zero = 0;
  AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &one, sizeof(one));
  AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &one, sizeof(one));

  AudioStreamBasicDescription format = {};
  format.mSampleRate = kSampleRate;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
  format.mBytesPerPacket = 2;
  format.mFramesPerPacket = 1;
  format.mBytesPerFrame = 2;
  format.mChannelsPerFrame = 1;
  format.mBitsPerChannel = 16;
  AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &format, sizeof(format));
  AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &format, sizeof(format));
  // The input callback renders into our own preallocated buffer.
  AudioUnitSetProperty(unit, kAudioUnitProperty_ShouldAllocateBuffer, kAudioUnitScope_Output, 1, &zero, sizeof(zero));

  AURenderCallbackStruct input = {TelevoInputCallback, _ctx};
  AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 1, &input, sizeof(input));
  AURenderCallbackStruct render = {TelevoRenderCallback, _ctx};
  AudioUnitSetProperty(unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &render, sizeof(render));

  OSStatus status = AudioUnitInitialize(unit);
  if (status != noErr) {
    NSLog(@"[TelevoAudio] voice processing unit failed to initialize: %d", (int)status);
    AudioComponentInstanceDispose(unit);
    return NO;
  }
  _ctx->unit = unit;
  return YES;
}

/// CallKit activates the audio session on its own schedule, and starting the
/// unit before that fails. Retries for a few seconds instead of leaving the
/// call silent — the default WebRTC device waits for activation the same way.
- (void)startUnitIfNeeded {
  if (_unitRunning || ![self createUnitIfNeeded]) return;
  OSStatus status = AudioOutputUnitStart(_ctx->unit);
  if (status == noErr) {
    _unitRunning = YES;
    _startAttempt = 0;
    NSLog(@"[TelevoAudio] audio unit running (noise suppression %@)", self.noiseSuppressionEnabled ? @"on" : @"off");
    return;
  }
  if (++_startAttempt > 40) {
    NSLog(@"[TelevoAudio] audio unit would not start: %d", (int)status);
    _startAttempt = 0;
    return;
  }
  __weak TelevoAudioDevice *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    TelevoAudioDevice *strongSelf = weakSelf;
    if (strongSelf && (strongSelf->_ctx->playing || strongSelf->_ctx->recording)) [strongSelf startUnitIfNeeded];
  });
}

- (void)stopUnitIfIdle {
  if (_ctx->playing || _ctx->recording || !_unitRunning) return;
  AudioOutputUnitStop(_ctx->unit);
  _unitRunning = NO;
}

- (void)disposeUnit {
  if (!_ctx->unit) return;
  AudioOutputUnitStop(_ctx->unit);
  AudioUnitUninitialize(_ctx->unit);
  AudioComponentInstanceDispose(_ctx->unit);
  _ctx->unit = nullptr;
  _unitRunning = NO;
}

#pragma mark - Interruptions

- (void)handleInterruption:(NSNotification *)note {
  AVAudioSessionInterruptionType type =
      (AVAudioSessionInterruptionType)[note.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
  if (type == AVAudioSessionInterruptionTypeBegan) {
    // A cellular call or alarm took the audio: the unit has stopped.
    _unitRunning = NO;
    [_delegate notifyAudioInputInterrupted];
    [_delegate notifyAudioOutputInterrupted];
  } else if (_ctx->playing || _ctx->recording) {
    [self startUnitIfNeeded];
  }
}

- (void)handleMediaServicesReset:(NSNotification *)note {
  // iOS restarted its audio daemon: every unit is dead and must be rebuilt.
  [self disposeUnit];
  if (_ctx->playing || _ctx->recording) [self startUnitIfNeeded];
}

@end
