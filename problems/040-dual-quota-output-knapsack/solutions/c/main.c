#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int n, B, I;
  if (scanf("%d%d%d", &n, &B, &I) != 3)
    return 0;
  size_t w = (size_t)B + 1;
  uint64_t *dp = calloc(((size_t)I + 1) * w, sizeof(*dp));
  while (n--) {
    int b, e;
    unsigned long long v;
    scanf("%d%d%llu", &b, &e, &v);
    for (int x = I; x >= e; x--)
      for (int y = B; y >= b; y--) {
        uint64_t q = dp[(size_t)(x - e) * w + y - b] + v;
        if (q > dp[(size_t)x * w + y])
          dp[(size_t)x * w + y] = q;
      }
  }
  printf("%llu\n", (unsigned long long)dp[(size_t)I * w + B]);
  free(dp);
}
