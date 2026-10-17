#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// nacl.secretbox (XSalsa20-Poly1305), byte-compatible with tweetnacl-js:
/// `out` receives the 16-byte tag followed by the ciphertext (mlen + 16 bytes).
/// Returns 0 on success.
int televo_secretbox_seal(uint8_t *out, const uint8_t *message, uint64_t mlen,
                          const uint8_t nonce[24], const uint8_t key[32]);

/// nacl.secretbox.open: `out` receives blen - 16 bytes of plaintext. Returns 0
/// on success, -1 when the box is too short or fails authentication (wrong
/// key, tampered data) — in which case `out` holds nothing usable.
int televo_secretbox_open(uint8_t *out, const uint8_t *box, uint64_t blen,
                          const uint8_t nonce[24], const uint8_t key[32]);

#ifdef __cplusplus
}
#endif
