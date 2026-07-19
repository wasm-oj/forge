#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef unsigned long long U;
static int *head, *to, *next, *level, *it, ec, T;
static U *cap;
void add(int u, int v, U c) {
  to[ec] = v;
  cap[ec] = c;
  next[ec] = head[u];
  head[u] = ec++;
  to[ec] = u;
  cap[ec] = 0;
  next[ec] = head[v];
  head[v] = ec++;
}
U dfs(int u, U f) {
  if (u == T)
    return f;
  for (int *e = &it[u]; *e >= 0; *e = next[*e])
    if (cap[*e] && level[to[*e]] == level[u] + 1) {
      U z = dfs(to[*e], f < cap[*e] ? f : cap[*e]);
      if (z) {
        cap[*e] -= z;
        cap[*e ^ 1] += z;
        return z;
      }
    }
  return 0;
}
int main(void) {
  int n, m, sn, tn;
  if (scanf("%d%d%d%d", &n, &m, &sn, &tn) != 4)
    return 0;
  U *c = malloc(sizeof(U) * (size_t)n), sum = 0;
  for (int i = 0; i < n; i++) {
    scanf("%llu", &c[i]);
    sum += c[i];
  }
  int *en = malloc(sizeof(int) * (size_t)sn),
      *dn = malloc(sizeof(int) * (size_t)tn);
  for (int i = 0; i < sn; i++) {
    scanf("%d", &en[i]);
    en[i]--;
  }
  for (int i = 0; i < tn; i++) {
    scanf("%d", &dn[i]);
    dn[i]--;
  }
  int *eu = malloc(sizeof(int) * (size_t)(m ? m : 1)),
      *ev = malloc(sizeof(int) * (size_t)(m ? m : 1));
  for (int i = 0; i < m; i++) {
    scanf("%d%d", &eu[i], &ev[i]);
    eu[i]--;
    ev[i]--;
  }
  int V = 2 * n + 2, S = 2 * n, lim = 2 * (n + m + sn + tn) + 2;
  T = S + 1;
  head = malloc(sizeof(int) * (size_t)V);
  to = malloc(sizeof(int) * (size_t)lim);
  next = malloc(sizeof(int) * (size_t)lim);
  cap = malloc(sizeof(U) * (size_t)lim);
  level = malloc(sizeof(int) * (size_t)V);
  it = malloc(sizeof(int) * (size_t)V);
  memset(head, 255, sizeof(int) * (size_t)V);
  U inf = sum + 1;
  for (int i = 0; i < n; i++)
    add(2 * i, 2 * i + 1, c[i]);
  for (int i = 0; i < m; i++)
    add(2 * eu[i] + 1, 2 * ev[i], inf);
  for (int i = 0; i < sn; i++)
    add(S, 2 * en[i], inf);
  for (int i = 0; i < tn; i++)
    add(2 * dn[i] + 1, T, inf);
  int *q = malloc(sizeof(int) * (size_t)V);
  U flow = 0;
  for (;;) {
    memset(level, 255, sizeof(int) * (size_t)V);
    int l = 0, r = 0;
    level[S] = 0;
    q[r++] = S;
    while (l < r) {
      int u = q[l++];
      for (int e = head[u]; e >= 0; e = next[e])
        if (cap[e] && level[to[e]] < 0) {
          level[to[e]] = level[u] + 1;
          q[r++] = to[e];
        }
    }
    if (level[T] < 0)
      break;
    memcpy(it, head, sizeof(int) * (size_t)V);
    U z;
    while ((z = dfs(S, inf)) != 0)
      flow += z;
  }
  printf("COST %llu\n", flow);
  return 0;
}
