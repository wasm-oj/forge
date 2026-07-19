#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int L, R, M;
  if (scanf("%d%d%d", &L, &R, &M) != 3)
    return 0;
  int *head = malloc(sizeof(int) * (size_t)L),
      *to = malloc(sizeof(int) * (size_t)(M ? M : 1)),
      *next = malloc(sizeof(int) * (size_t)(M ? M : 1));
  for (int i = 0; i < L; i++)
    head[i] = -1;
  for (int e = 0; e < M; e++) {
    int u, v;
    scanf("%d%d", &u, &v);
    u--;
    to[e] = v - 1;
    next[e] = head[u];
    head[u] = e;
  }
  int *pu = malloc(sizeof(int) * (size_t)L),
      *pv = malloc(sizeof(int) * (size_t)R),
      *dist = malloc(sizeof(int) * (size_t)L),
      *q = malloc(sizeof(int) * (size_t)L),
      *cur = malloc(sizeof(int) * (size_t)L),
      *su = malloc(sizeof(int) * (size_t)L),
      *sv = malloc(sizeof(int) * (size_t)L);
  for (int i = 0; i < L; i++)
    pu[i] = -1;
  for (int i = 0; i < R; i++)
    pv[i] = -1;
  int matching = 0;
  for (;;) {
    int l = 0, r = 0, terminal = -1;
    for (int u = 0; u < L; u++) {
      dist[u] = pu[u] < 0 ? 0 : -1;
      if (pu[u] < 0)
        q[r++] = u;
    }
    while (l < r) {
      int u = q[l++];
      if (terminal >= 0 && dist[u] >= terminal)
        continue;
      for (int e = head[u]; e >= 0; e = next[e]) {
        int w = pv[to[e]];
        if (w < 0)
          terminal = dist[u];
        else if (dist[w] < 0) {
          dist[w] = dist[u] + 1;
          q[r++] = w;
        }
      }
    }
    if (terminal < 0)
      break;
    for (int i = 0; i < L; i++)
      cur[i] = head[i];
    for (int root = 0; root < L; root++) {
      if (pu[root] >= 0)
        continue;
      int ut = 1, vt = 0, ok = 0;
      su[0] = root;
      while (ut && !ok) {
        int u = su[ut - 1], desc = 0;
        while (cur[u] >= 0) {
          int e = cur[u];
          cur[u] = next[e];
          int v = to[e], w = pv[v];
          if (w < 0 && dist[u] == terminal) {
            pu[u] = v;
            pv[v] = u;
            for (int i = vt - 1; i >= 0; i--) {
              pu[su[i]] = sv[i];
              pv[sv[i]] = su[i];
            }
            ok = 1;
            break;
          }
          if (w >= 0 && dist[u] < terminal && dist[w] == dist[u] + 1) {
            sv[vt++] = v;
            su[ut++] = w;
            desc = 1;
            break;
          }
        }
        if (!ok && !desc) {
          dist[u] = -1;
          ut--;
          if (vt)
            vt--;
        }
      }
      if (ok)
        matching++;
    }
  }
  printf("%d\n", matching);
  return 0;
}
