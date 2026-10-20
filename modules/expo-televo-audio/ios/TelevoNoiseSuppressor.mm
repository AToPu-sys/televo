#include "TelevoNoiseSuppressor.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "rnnoise.h"

namespace televo {

NoiseSuppressor::NoiseSuppressor(RNNModel *model) : state_(rnnoise_create(model)) {
  // One frame of silence up front: the 10 ms the first real frame needs.
  std::memset(ring_, 0, sizeof(ring_));
  ringWrite_ = kFrame;
  ringCount_ = kFrame;
}

NoiseSuppressor::~NoiseSuppressor() {
  if (state_) rnnoise_destroy(state_);
}

void NoiseSuppressor::process(int16_t *samples, uint32_t count) {
  for (uint32_t i = 0; i < count; i++) {
    input_[inputFill_++] = samples[i];
    if (inputFill_ == kFrame) {
      inputFill_ = 0;
      if (state_ && enabled.load(std::memory_order_relaxed)) {
        lastVoiceProbability.store(rnnoise_process_frame(state_, output_, input_), std::memory_order_relaxed);
      } else {
        std::memcpy(output_, input_, sizeof(output_));
      }
      for (int k = 0; k < kFrame && ringCount_ < kRing; k++) {
        float value = std::max(-32768.0f, std::min(32767.0f, std::nearbyint(output_[k])));
        ring_[ringWrite_] = static_cast<int16_t>(value);
        ringWrite_ = (ringWrite_ + 1) % kRing;
        ringCount_++;
      }
    }
    if (ringCount_ > 0) {
      samples[i] = ring_[ringRead_];
      ringRead_ = (ringRead_ + 1) % kRing;
      ringCount_--;
    } else {
      samples[i] = 0;
    }
  }
}

}  // namespace televo
