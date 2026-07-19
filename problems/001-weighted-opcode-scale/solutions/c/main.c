#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int K, W, R, Q;
  if (scanf("%d%d%d%d", &K, &W, &R, &Q) != 4)
    return 0;
  uint64_t *wt = malloc((K + 1) * sizeof(*wt));
  for (int i = 0; i <= K; i++)
    wt[i] = 1000;
  for (int j = 0; j < W; j++) {
    int id;
    unsigned long long x;
    scanf("%d%llu", &id, &x);
    wt[id] = x;
  }
  uint64_t *pc = calloc(R + 1, sizeof(*pc)), *pn = calloc(R + 1, sizeof(*pn));
  uint64_t *rw = malloc(R * sizeof(*rw)), *rc = malloc(R * sizeof(*rc));
  for (int i = 0; i < R; i++) {
    int id;
    unsigned long long c;
    scanf("%d%llu", &id, &c);
    rw[i] = wt[id];
    rc[i] = c;
    pc[i + 1] = pc[i] + rw[i] * rc[i];
    pn[i + 1] = pn[i] + rc[i];
  }
  while (Q--) {
    unsigned long long b;
    scanf("%llu", &b);
    int lo = 0, hi = R + 1;
    while (lo + 1 < hi) {
      int m = lo + (hi - lo) / 2;
      if (pc[m] <= b)
        lo = m;
      else
        hi = m;
    }
    uint64_t done = pn[lo], cost = pc[lo];
    if (lo < R) {
      uint64_t take = (b - cost) / rw[lo];
      if (take > rc[lo])
        take = rc[lo];
      done += take;
      cost += take * rw[lo];
    }
    printf("%llu %llu\n", (unsigned long long)done, (unsigned long long)cost);
  }
  free(wt);
  free(pc);
  free(pn);
  free(rw);
  free(rc);
  return 0;
}
