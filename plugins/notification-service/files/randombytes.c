// TweetNaCl links against randombytes() for its key-generation functions.
// The extension only ever opens boxes, but the symbol has to exist.
#include <stdlib.h>

void randombytes(unsigned char *x, unsigned long long n) {
  arc4random_buf(x, (size_t)n);
}
