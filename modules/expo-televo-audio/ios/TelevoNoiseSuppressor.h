// Streaming wrapper around rnnoise for the real-time audio thread.
//
// rnnoise works on fixed 480-sample frames (10 ms at 48 kHz) of float
// samples in 16-bit range; the microphone delivers whatever buffer size iOS
// picked (often 256, 512 or 1024 frames). Samples go through two FIFOs: in
// until a full frame exists, out once denoised. The output FIFO starts one
// frame deep, so the stream is delayed by exactly 10 ms and never underruns.
//
// Nothing here allocates or locks after construction: process() runs on the
// audio thread, which must never wait.

#pragma once

#include <atomic>
#include <cstdint>

struct DenoiseState;
struct RNNModel;

namespace televo {

class NoiseSuppressor {
 public:
  /// `model` must outlive the suppressor.
  explicit NoiseSuppressor(RNNModel *model);
  ~NoiseSuppressor();

  NoiseSuppressor(const NoiseSuppressor &) = delete;
  NoiseSuppressor &operator=(const NoiseSuppressor &) = delete;

  /// Denoises `count` mono 48 kHz samples in place.
  void process(int16_t *samples, uint32_t count);

  /// Bypass without changing the latency, so toggling mid-call is seamless.
  std::atomic<bool> enabled{true};

  /// Voice probability of the last frame, 0…1 (for diagnostics).
  std::atomic<float> lastVoiceProbability{0};

 private:
  static constexpr int kFrame = 480;
  static constexpr int kRing = 16384;

  DenoiseState *state_;
  float input_[kFrame];
  float output_[kFrame];
  int inputFill_ = 0;
  int16_t ring_[kRing];
  int ringRead_ = 0;
  int ringWrite_ = 0;
  int ringCount_ = 0;
};

}  // namespace televo
