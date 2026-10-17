// nacl.secretbox — XSalsa20-Poly1305 — written for speed, byte-compatible
// with tweetnacl-js and with TweetNaCl's crypto_secretbox.
//
// TweetNaCl (the reference this replaces) is deliberately tiny, not fast:
// byte-at-a-time Salsa20 and a 17-limb Poly1305. Here Salsa20 works on 32-bit
// words (D. J. Bernstein's specification, 20 rounds) and Poly1305 is the
// 64-bit "donna" construction (3 x 44-bit limbs, 128-bit products), the same
// shape libsodium and most fast implementations use. Both are public-domain
// algorithms; nothing here is new cryptography, only a faster spelling of it.
//
// Little-endian only — every Apple platform is.

#include "TelevoSecretBox.h"

#include <string.h>

#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "TelevoSecretBox assumes a little-endian CPU"
#endif

typedef unsigned __int128 u128;

static inline uint32_t load32(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static inline void store32(uint8_t *p, uint32_t v) { memcpy(p, &v, 4); }
static inline uint64_t load64(const uint8_t *p) { uint64_t v; memcpy(&v, p, 8); return v; }
static inline void store64(uint8_t *p, uint64_t v) { memcpy(p, &v, 8); }

// Never optimised away: keys and keystream must not linger in memory.
static void wipe(void *p, size_t n) {
  volatile uint8_t *v = (volatile uint8_t *)p;
  while (n--) *v++ = 0;
}

// ---------------------------------------------------------------- Salsa20

#define ROTL(v, n) (((v) << (n)) | ((v) >> (32 - (n))))
#define QR(a, b, c, d)          \
  b ^= ROTL(a + d, 7);          \
  c ^= ROTL(b + a, 9);          \
  d ^= ROTL(c + b, 13);         \
  a ^= ROTL(d + c, 18)

static const uint32_t SIGMA[4] = {0x61707865, 0x3320646e, 0x79622d32, 0x6b206574}; // "expand 32-byte k"

static inline void salsa20_rounds(uint32_t x[16]) {
  for (int i = 0; i < 10; i++) {
    QR(x[0], x[4], x[8], x[12]);   // columns
    QR(x[5], x[9], x[13], x[1]);
    QR(x[10], x[14], x[2], x[6]);
    QR(x[15], x[3], x[7], x[11]);
    QR(x[0], x[1], x[2], x[3]);    // rows
    QR(x[5], x[6], x[7], x[4]);
    QR(x[10], x[11], x[8], x[9]);
    QR(x[15], x[12], x[13], x[14]);
  }
}

static void salsa20_setup(uint32_t s[16], const uint8_t key[32], const uint8_t in[16]) {
  s[0] = SIGMA[0];
  s[1] = load32(key + 0); s[2] = load32(key + 4); s[3] = load32(key + 8); s[4] = load32(key + 12);
  s[5] = SIGMA[1];
  s[6] = load32(in + 0); s[7] = load32(in + 4); s[8] = load32(in + 8); s[9] = load32(in + 12);
  s[10] = SIGMA[2];
  s[11] = load32(key + 16); s[12] = load32(key + 20); s[13] = load32(key + 24); s[14] = load32(key + 28);
  s[15] = SIGMA[3];
}

// HSalsa20: the XSalsa20 subkey from the key and the first 16 nonce bytes.
static void hsalsa20(uint8_t out[32], const uint8_t key[32], const uint8_t nonce16[16]) {
  uint32_t x[16];
  salsa20_setup(x, key, nonce16);
  salsa20_rounds(x);
  store32(out + 0, x[0]); store32(out + 4, x[5]); store32(out + 8, x[10]); store32(out + 12, x[15]);
  store32(out + 16, x[6]); store32(out + 20, x[7]); store32(out + 24, x[8]); store32(out + 28, x[9]);
  wipe(x, sizeof x);
}

// One 64-byte Salsa20 keystream block for `state` (nonce and counter set).
static inline void salsa20_block(uint8_t out[64], const uint32_t state[16]) {
  uint32_t x[16];
  memcpy(x, state, sizeof x);
  salsa20_rounds(x);
  for (int i = 0; i < 16; i++) store32(out + 4 * i, x[i] + state[i]);
}

// XORs `len` bytes of keystream into dst, starting at block 1 — block 0 is
// reserved: its first 32 bytes are the Poly1305 key and the other 32 cover
// the first 32 bytes of the message (handled by the caller).
static void salsa20_xor_from_block1(uint8_t *dst, const uint8_t *src, size_t len, uint32_t state[16]) {
  uint8_t block[64];
  uint64_t counter = 1;
  while (len > 0) {
    state[8] = (uint32_t)counter;
    state[9] = (uint32_t)(counter >> 32);
    salsa20_block(block, state);
    size_t n = len < 64 ? len : 64;
    if (n == 64) {
      for (int i = 0; i < 64; i += 8) store64(dst + i, load64(src + i) ^ load64(block + i));
    } else {
      for (size_t i = 0; i < n; i++) dst[i] = src[i] ^ block[i];
    }
    dst += n; src += n; len -= n; counter++;
  }
  wipe(block, sizeof block);
}

// --------------------------------------------------------------- Poly1305

typedef struct {
  uint64_t r[3], h[3], pad[2];
  size_t leftover;
  uint8_t buffer[16];
  int final;
} poly1305;

static void poly1305_init(poly1305 *st, const uint8_t key[32]) {
  uint64_t t0 = load64(key), t1 = load64(key + 8);
  st->r[0] = t0 & 0xffc0fffffffULL;
  st->r[1] = ((t0 >> 44) | (t1 << 20)) & 0xfffffc0ffffULL;
  st->r[2] = (t1 >> 24) & 0x00ffffffc0fULL;
  st->h[0] = st->h[1] = st->h[2] = 0;
  st->pad[0] = load64(key + 16);
  st->pad[1] = load64(key + 24);
  st->leftover = 0;
  st->final = 0;
}

static void poly1305_blocks(poly1305 *st, const uint8_t *m, size_t bytes) {
  const uint64_t hibit = st->final ? 0 : ((uint64_t)1 << 40);
  const uint64_t r0 = st->r[0], r1 = st->r[1], r2 = st->r[2];
  const uint64_t s1 = r1 * (5 << 2), s2 = r2 * (5 << 2);
  uint64_t h0 = st->h[0], h1 = st->h[1], h2 = st->h[2], c;
  u128 d0, d1, d2;
  while (bytes >= 16) {
    uint64_t t0 = load64(m), t1 = load64(m + 8);
    h0 += t0 & 0xfffffffffffULL;
    h1 += ((t0 >> 44) | (t1 << 20)) & 0xfffffffffffULL;
    h2 += ((t1 >> 24) & 0x3ffffffffffULL) | hibit;
    d0 = (u128)h0 * r0 + (u128)h1 * s2 + (u128)h2 * s1;
    d1 = (u128)h0 * r1 + (u128)h1 * r0 + (u128)h2 * s2;
    d2 = (u128)h0 * r2 + (u128)h1 * r1 + (u128)h2 * r0;
    c = (uint64_t)(d0 >> 44); h0 = (uint64_t)d0 & 0xfffffffffffULL;
    d1 += c; c = (uint64_t)(d1 >> 44); h1 = (uint64_t)d1 & 0xfffffffffffULL;
    d2 += c; c = (uint64_t)(d2 >> 42); h2 = (uint64_t)d2 & 0x3ffffffffffULL;
    h0 += c * 5; c = h0 >> 44; h0 &= 0xfffffffffffULL;
    h1 += c;
    m += 16;
    bytes -= 16;
  }
  st->h[0] = h0; st->h[1] = h1; st->h[2] = h2;
}

static void poly1305_update(poly1305 *st, const uint8_t *m, size_t bytes) {
  if (st->leftover) {
    size_t want = 16 - st->leftover;
    if (want > bytes) want = bytes;
    memcpy(st->buffer + st->leftover, m, want);
    m += want; bytes -= want; st->leftover += want;
    if (st->leftover < 16) return;
    poly1305_blocks(st, st->buffer, 16);
    st->leftover = 0;
  }
  if (bytes >= 16) {
    size_t want = bytes & ~(size_t)15;
    poly1305_blocks(st, m, want);
    m += want; bytes -= want;
  }
  if (bytes) {
    memcpy(st->buffer, m, bytes);
    st->leftover = bytes;
  }
}

static void poly1305_finish(poly1305 *st, uint8_t mac[16]) {
  if (st->leftover) {
    size_t i = st->leftover;
    st->buffer[i++] = 1;
    for (; i < 16; i++) st->buffer[i] = 0;
    st->final = 1;
    poly1305_blocks(st, st->buffer, 16);
  }
  uint64_t h0 = st->h[0], h1 = st->h[1], h2 = st->h[2], c, g0, g1, g2, t0, t1;
  c = h1 >> 44; h1 &= 0xfffffffffffULL;
  h2 += c; c = h2 >> 42; h2 &= 0x3ffffffffffULL;
  h0 += c * 5; c = h0 >> 44; h0 &= 0xfffffffffffULL;
  h1 += c; c = h1 >> 44; h1 &= 0xfffffffffffULL;
  h2 += c; c = h2 >> 42; h2 &= 0x3ffffffffffULL;
  h0 += c * 5; c = h0 >> 44; h0 &= 0xfffffffffffULL;
  h1 += c;
  // h - p, kept only if h >= p (constant time)
  g0 = h0 + 5; c = g0 >> 44; g0 &= 0xfffffffffffULL;
  g1 = h1 + c; c = g1 >> 44; g1 &= 0xfffffffffffULL;
  g2 = h2 + c - ((uint64_t)1 << 42);
  c = (g2 >> 63) - 1;
  g0 &= c; g1 &= c; g2 &= c;
  c = ~c;
  h0 = (h0 & c) | g0; h1 = (h1 & c) | g1; h2 = (h2 & c) | g2;
  // + s
  t0 = st->pad[0]; t1 = st->pad[1];
  h0 += t0 & 0xfffffffffffULL; c = h0 >> 44; h0 &= 0xfffffffffffULL;
  h1 += (((t0 >> 44) | (t1 << 20)) & 0xfffffffffffULL) + c; c = h1 >> 44; h1 &= 0xfffffffffffULL;
  h2 += ((t1 >> 24) & 0x3ffffffffffULL) + c; h2 &= 0x3ffffffffffULL;
  store64(mac, h0 | (h1 << 44));
  store64(mac + 8, (h1 >> 20) | (h2 << 24));
  wipe(st, sizeof *st);
}

static int verify16(const uint8_t *a, const uint8_t *b) {
  uint32_t d = 0;
  for (int i = 0; i < 16; i++) d |= a[i] ^ b[i];
  return (1 & ((d - 1) >> 8)) - 1; // 0 when equal, -1 otherwise
}

// --------------------------------------------------------------- secretbox

// Subkey, Salsa20 state for the second half of the nonce, and block 0.
static void secretbox_begin(uint32_t state[16], uint8_t block0[64], const uint8_t nonce[24], const uint8_t key[32]) {
  uint8_t subkey[32], in[16] = {0};
  hsalsa20(subkey, key, nonce);
  memcpy(in, nonce + 16, 8); // nonce tail, counter 0
  salsa20_setup(state, subkey, in);
  salsa20_block(block0, state);
  wipe(subkey, sizeof subkey);
}

int televo_secretbox_seal(uint8_t *out, const uint8_t *message, uint64_t mlen,
                          const uint8_t nonce[24], const uint8_t key[32]) {
  uint32_t state[16];
  uint8_t block0[64];
  poly1305 mac;
  uint8_t *c = out + 16;
  size_t len = (size_t)mlen;

  secretbox_begin(state, block0, nonce, key);
  size_t head = len < 32 ? len : 32;
  for (size_t i = 0; i < head; i++) c[i] = message[i] ^ block0[32 + i];
  if (len > 32) salsa20_xor_from_block1(c + 32, message + 32, len - 32, state);

  poly1305_init(&mac, block0);
  poly1305_update(&mac, c, len);
  poly1305_finish(&mac, out);

  wipe(state, sizeof state);
  wipe(block0, sizeof block0);
  return 0;
}

int televo_secretbox_open(uint8_t *out, const uint8_t *box, uint64_t blen,
                          const uint8_t nonce[24], const uint8_t key[32]) {
  if (blen < 16) return -1;
  uint32_t state[16];
  uint8_t block0[64], tag[16];
  poly1305 mac;
  const uint8_t *c = box + 16;
  size_t len = (size_t)blen - 16;

  secretbox_begin(state, block0, nonce, key);
  poly1305_init(&mac, block0);
  poly1305_update(&mac, c, len);
  poly1305_finish(&mac, tag);
  if (verify16(tag, box) != 0) {
    wipe(state, sizeof state);
    wipe(block0, sizeof block0);
    return -1;
  }

  size_t head = len < 32 ? len : 32;
  for (size_t i = 0; i < head; i++) out[i] = c[i] ^ block0[32 + i];
  if (len > 32) salsa20_xor_from_block1(out + 32, c + 32, len - 32, state);

  wipe(state, sizeof state);
  wipe(block0, sizeof block0);
  return 0;
}
