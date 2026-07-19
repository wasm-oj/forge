#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
  int G, C;
  if (scanf("%d%d", &G, &C) != 2)
    return 0;
  uint64_t *dp = calloc((size_t)C + 1, sizeof(*dp)),
           *nx = malloc(((size_t)C + 1) * sizeof(*nx));
  while (G--) {
    int k;
    scanf("%d", &k);
    int *w = malloc((size_t)k * sizeof(*w));
    uint64_t *v = malloc((size_t)k * sizeof(*v));
    for (int i = 0; i < k; i++) {
      unsigned long long x;
      scanf("%d%llu", &w[i], &x);
      v[i] = x;
    }
    memcpy(nx, dp, ((size_t)C + 1) * sizeof(*dp));
    for (int i = 0; i < k; i++)
      for (int c = w[i]; c <= C; c++) {
        uint64_t q = dp[c - w[i]] + v[i];
        if (q > nx[c])
          nx[c] = q;
      }
    uint64_t *tmp = dp;
    dp = nx;
    nx = tmp;
    free(w);
    free(v);
  }
  printf("%llu\n", (unsigned long long)dp[C]);
  free(dp);
  free(nx);
}
