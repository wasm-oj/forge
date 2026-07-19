#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int n, c;
  if (scanf("%d%d", &n, &c) != 2)
    return 0;
  uint64_t *dp = calloc((size_t)c + 1, sizeof(*dp));
  while (n--) {
    int w;
    unsigned long long v;
    scanf("%d%llu", &w, &v);
    for (int x = c; x >= w; x--) {
      uint64_t q = dp[x - w] + v;
      if (q > dp[x])
        dp[x] = q;
    }
  }
  printf("%llu\n", (unsigned long long)dp[c]);
  free(dp);
}
