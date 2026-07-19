#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
static int *head, *next, *to, *order, *after, cnt;
static void dfs(int u) {
  int pos = cnt;
  order[cnt++] = u;
  for (int e = head[u]; e != -1; e = next[e])
    dfs(to[e]);
  after[pos] = cnt;
}
int main(void) {
  int n, C;
  if (scanf("%d%d", &n, &C) != 2)
    return 0;
  int *sz = calloc(n + 1, sizeof(*sz));
  uint64_t *val = calloc(n + 1, sizeof(*val));
  head = malloc((n + 1) * sizeof(*head));
  next = malloc(n * sizeof(*next));
  to = malloc(n * sizeof(*to));
  order = malloc(n * sizeof(*order));
  after = malloc(n * sizeof(*after));
  for (int i = 0; i <= n; i++)
    head[i] = -1;
  for (int i = 1, p; i <= n; i++) {
    unsigned long long v;
    scanf("%d%d%llu", &p, &sz[i], &v);
    val[i] = v;
    to[i - 1] = i;
    next[i - 1] = head[p];
    head[p] = i - 1;
  }
  for (int e = head[0]; e != -1; e = next[e])
    dfs(to[e]);
  size_t w = (size_t)C + 1;
  uint64_t *dp = calloc((size_t)(n + 1) * w, sizeof(*dp));
  for (int i = n - 1; i >= 0; i--) {
    int u = order[i];
    for (int c = 0; c <= C; c++) {
      uint64_t best = dp[(size_t)after[i] * w + c];
      if (c >= sz[u]) {
        uint64_t q = val[u] + dp[(size_t)(i + 1) * w + c - sz[u]];
        if (q > best)
          best = q;
      }
      dp[(size_t)i * w + c] = best;
    }
  }
  printf("%llu\n", (unsigned long long)dp[C]);
  free(sz);
  free(val);
  free(head);
  free(next);
  free(to);
  free(order);
  free(after);
  free(dp);
}
