#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int N, Q;
  unsigned long long C;
  if (scanf("%d%d%llu", &N, &Q, &C) != 3)
    return 0;
  uint64_t *pi = calloc(N + 1, sizeof(*pi)), *pm = calloc(N + 1, sizeof(*pm));
  unsigned char *bad = calloc(N + 2, 1);
  int *next = malloc((N + 2) * sizeof(*next));
  for (int i = 1, k; i <= N; i++) {
    unsigned long long ini;
    long long mx;
    scanf("%d%llu%lld", &k, &ini, &mx);
    bad[i] = (k == 64 || ini > C || (mx >= 0 && (unsigned long long)mx < ini));
    pi[i] = pi[i - 1];
    pm[i] = pm[i - 1];
    if (!bad[i]) {
      pi[i] += ini;
      pm[i] += mx < 0
                   ? C
                   : ((unsigned long long)mx < C ? (unsigned long long)mx : C);
    }
  }
  next[N + 1] = N + 1;
  for (int i = N; i >= 1; i--)
    next[i] = bad[i] ? i : next[i + 1];
  while (Q--) {
    int l, r;
    scanf("%d%d", &l, &r);
    if (next[l] <= r)
      printf("REJECT %d\n", next[l]);
    else
      printf("ACCEPT %llu %llu\n",
             (unsigned long long)((pi[r] - pi[l - 1]) * 65536ULL),
             (unsigned long long)((pm[r] - pm[l - 1]) * 65536ULL));
  }
  free(pi);
  free(pm);
  free(bad);
  free(next);
}
