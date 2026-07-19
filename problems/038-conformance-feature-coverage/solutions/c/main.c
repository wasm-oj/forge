#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static int pc(unsigned x) {
  int n = 0;
  while (x) {
    x &= x - 1;
    n++;
  }
  return n;
}
int main(void) {
  int F, N;
  unsigned long long B;
  if (scanf("%d%d%llu", &F, &N, &B) != 3)
    return 0;
  int S = 1 << F;
  uint64_t *dp = malloc((size_t)S * sizeof(*dp)),
           *nx = malloc((size_t)S * sizeof(*nx));
  const uint64_t INF = UINT64_MAX / 4;
  for (int i = 0; i < S; i++)
    dp[i] = INF;
  dp[0] = 0;
  while (N--) {
    unsigned long long cost;
    int k, m = 0, x;
    scanf("%llu%d", &cost, &k);
    while (k--) {
      scanf("%d", &x);
      m |= 1 << (x - 1);
    }
    memcpy(nx, dp, (size_t)S * sizeof(*dp));
    for (int s = 0; s < S; s++)
      if (dp[s] != INF) {
        int q = s | m;
        uint64_t v = dp[s] + cost;
        if (v < nx[q])
          nx[q] = v;
      }
    uint64_t *tmp = dp;
    dp = nx;
    nx = tmp;
  }
  int ans = 0;
  for (int s = 0; s < S; s++)
    if (dp[s] <= B && pc((unsigned)s) > ans)
      ans = pc((unsigned)s);
  printf("%d\n", ans);
  free(dp);
  free(nx);
}
