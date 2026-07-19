#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int P, S, N, Q;
  if (scanf("%d%d%d%d", &P, &S, &N, &Q) != 4)
    return 0;
  int *c = calloc(P + 1, sizeof(*c));
  unsigned long long *lo = malloc((P + 1) * sizeof(*lo)),
                     *hi = calloc(P + 1, sizeof(*hi));
  for (int i = 0; i <= P; i++)
    lo[i] = ULLONG_MAX;
  for (int i = 0, p, s; i < N; i++) {
    unsigned long long x;
    scanf("%d%d%llu", &p, &s, &x);
    c[p]++;
    if (x < lo[p])
      lo[p] = x;
    if (x > hi[p])
      hi[p] = x;
  }
  while (Q--) {
    int p;
    unsigned long long raw;
    scanf("%d%llu", &p, &raw);
    if (c[p] != S || lo[p] != hi[p])
      puts("INVALID");
    else
      printf("%llu %llu\n", lo[p], raw > lo[p] ? raw - lo[p] : 0ULL);
  }
  free(c);
  free(lo);
  free(hi);
}
