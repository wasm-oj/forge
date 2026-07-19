#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
  int n, m;
  if (scanf("%d%d", &n, &m) != 2)
    return 0;
  int *eu = malloc(sizeof(int) * (size_t)(m ? m : 1)),
      *ev = malloc(sizeof(int) * (size_t)(m ? m : 1)),
      *h = malloc(sizeof(int) * (size_t)n),
      *rh = malloc(sizeof(int) * (size_t)n),
      *to = malloc(sizeof(int) * (size_t)(m ? m : 1)),
      *rto = malloc(sizeof(int) * (size_t)(m ? m : 1)),
      *nx = malloc(sizeof(int) * (size_t)(m ? m : 1)),
      *rnx = malloc(sizeof(int) * (size_t)(m ? m : 1));
  memset(h, 255, sizeof(int) * (size_t)n);
  memset(rh, 255, sizeof(int) * (size_t)n);
  unsigned char *self = calloc((size_t)n, 1);
  for (int e = 0; e < m; e++) {
    scanf("%d%d", &eu[e], &ev[e]);
    eu[e]--;
    ev[e]--;
    to[e] = ev[e];
    nx[e] = h[eu[e]];
    h[eu[e]] = e;
    rto[e] = eu[e];
    rnx[e] = rh[ev[e]];
    rh[ev[e]] = e;
    if (eu[e] == ev[e])
      self[eu[e]] = 1;
  }
  unsigned char *seen = calloc((size_t)n, 1);
  int *iter = malloc(sizeof(int) * (size_t)n),
      *st = malloc(sizeof(int) * (size_t)n),
      *order = malloc(sizeof(int) * (size_t)n);
  memcpy(iter, h, sizeof(int) * (size_t)n);
  int os = 0;
  for (int s = 0; s < n; s++) {
    if (seen[s])
      continue;
    int top = 1;
    st[0] = s;
    seen[s] = 1;
    while (top) {
      int u = st[top - 1], e = iter[u];
      if (e >= 0) {
        iter[u] = nx[e];
        int v = to[e];
        if (!seen[v]) {
          seen[v] = 1;
          st[top++] = v;
        }
      } else {
        order[os++] = u;
        top--;
      }
    }
  }
  int *comp = malloc(sizeof(int) * (size_t)n);
  memset(comp, 255, sizeof(int) * (size_t)n);
  int cc = 0;
  for (int oi = n - 1; oi >= 0; oi--) {
    int s = order[oi];
    if (comp[s] >= 0)
      continue;
    int top = 1;
    st[0] = s;
    comp[s] = cc;
    while (top) {
      int u = st[--top];
      for (int e = rh[u]; e >= 0; e = rnx[e])
        if (comp[rto[e]] < 0) {
          comp[rto[e]] = cc;
          st[top++] = rto[e];
        }
    }
    cc++;
  }
  int *ch = malloc(sizeof(int) * (size_t)cc),
      *mn = malloc(sizeof(int) * (size_t)n),
      *sz = calloc((size_t)cc, sizeof(int));
  memset(ch, 255, sizeof(int) * (size_t)cc);
  for (int i = n - 1; i >= 0; i--) {
    int c = comp[i];
    mn[i] = ch[c];
    ch[c] = i;
    sz[c]++;
  }
  unsigned char *indeg = calloc((size_t)cc, 1);
  for (int e = 0; e < m; e++)
    if (comp[eu[e]] != comp[ev[e]])
      indeg[comp[ev[e]]] = 1;
  int groups = 0, wake = 0;
  for (int c = 0; c < cc; c++) {
    wake += !indeg[c];
    groups += sz[c] > 1 || self[ch[c]];
  }
  printf("%d %d\n", groups, wake);
  for (int i = 0; i < n; i++) {
    int c = comp[i];
    if (ch[c] != i || !(sz[c] > 1 || self[i]))
      continue;
    printf("%d", sz[c]);
    for (int v = ch[c]; v >= 0; v = mn[v])
      printf(" %d", v + 1);
    putchar('\n');
  }
  return 0;
}
