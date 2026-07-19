#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
static unsigned byte_at(uint64_t s, uint64_t x) {
  uint64_t z = s + UINT64_C(0x9e3779b97f4a7c15) * (x / 8 + 1);
  z = (z ^ (z >> 30)) * UINT64_C(0xbf58476d1ce4e5b9);
  z = (z ^ (z >> 27)) * UINT64_C(0x94d049bb133111eb);
  z ^= z >> 31;
  return (unsigned)((z >> (8 * (x % 8))) & 255);
}
int main(void) {
  uint64_t a, b, S;
  int q;
  if (scanf("%" SCNu64 " %" SCNu64 " %" SCNu64 " %d", &a, &b, &S, &q) != 4)
    return 0;
  uint64_t pos = 0;
  while (q--) {
    uint64_t k;
    scanf("%" SCNu64, &k);
    uint64_t p[2] = {pos, pos + k - 1};
    unsigned v[2];
    for (int i = 0; i < 2; i++)
      v[i] = p[i] < S ? byte_at(a, p[i]) : byte_at(b, p[i] - S);
    printf("%u %u\n", v[0], v[1]);
    pos += k;
  }
}
