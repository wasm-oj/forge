#include <stdio.h>
#include <stdlib.h>
typedef unsigned long long U;
typedef struct {
  int u, v;
  U w;
} E;
int cmp(const void *a, const void *b) {
  U x = ((const E *)a)->w, y = ((const E *)b)->w;
  return x < y ? -1 : x > y;
}
int find(int *p, int x) {
  int r = x;
  while (p[r] != r)
    r = p[r];
  while (p[x] != x) {
    int y = p[x];
    p[x] = r;
    x = y;
  }
  return r;
}
int main(void) {
  int n, m;
  if (scanf("%d%d", &n, &m) != 2)
    return 0;
  E *e = malloc(sizeof(E) * (size_t)(m ? m : 1));
  for (int i = 0; i < m; i++) {
    scanf("%d%d%llu", &e[i].u, &e[i].v, &e[i].w);
    e[i].u--;
    e[i].v--;
  }
  qsort(e, (size_t)m, sizeof(E), cmp);
  int *p = malloc(sizeof(int) * (size_t)n),
      *sz = malloc(sizeof(int) * (size_t)n);
  for (int i = 0; i < n; i++) {
    p[i] = i;
    sz[i] = 1;
  }
  U cost = 0;
  int take = 0;
  for (int i = 0; i < m && take < n - 1; i++) {
    int u = find(p, e[i].u), v = find(p, e[i].v);
    if (u == v)
      continue;
    if (sz[u] < sz[v]) {
      int t = u;
      u = v;
      v = t;
    }
    p[v] = u;
    sz[u] += sz[v];
    cost += e[i].w;
    take++;
  }
  if (take == n - 1)
    printf("COST %llu\n", cost);
  else
    puts("IMPOSSIBLE");
  return 0;
}
