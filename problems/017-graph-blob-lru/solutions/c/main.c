#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef unsigned long long U;
static int *lp, *ln, *rh, *nb, *rp, *rn, head = -1, tail = -1;
static unsigned char *cached;
void lr(int x) {
  if (lp[x] >= 0)
    ln[lp[x]] = ln[x];
  else
    head = ln[x];
  if (ln[x] >= 0)
    lp[ln[x]] = lp[x];
  else
    tail = lp[x];
  lp[x] = ln[x] = -1;
}
void touch(int x) {
  if (cached[x])
    lr(x);
  cached[x] = 1;
  lp[x] = tail;
  if (tail >= 0)
    ln[tail] = x;
  else
    head = x;
  tail = x;
}
void detach(int u) {
  int x = nb[u];
  if (x < 0)
    return;
  if (rp[u] >= 0)
    rn[rp[u]] = rn[u];
  else
    rh[x] = rn[u];
  if (rn[u] >= 0)
    rp[rn[u]] = rp[u];
  nb[u] = rp[u] = rn[u] = -1;
}
void attach(int u, int x) {
  nb[u] = x;
  rn[u] = rh[x];
  if (rh[x] >= 0)
    rp[rh[x]] = u;
  rh[x] = u;
  rp[u] = -1;
}
int main(void) {
  int n, d, q;
  U cap;
  if (scanf("%d%d%d%llu", &n, &d, &q, &cap) != 4)
    return 0;
  U *sz = malloc(sizeof(U) * (size_t)d);
  for (int i = 0; i < d; i++)
    scanf("%llu", &sz[i]);
  lp = malloc(sizeof(int) * (size_t)d);
  ln = malloc(sizeof(int) * (size_t)d);
  rh = malloc(sizeof(int) * (size_t)d);
  cached = calloc((size_t)d, 1);
  nb = malloc(sizeof(int) * (size_t)n);
  rp = malloc(sizeof(int) * (size_t)n);
  rn = malloc(sizeof(int) * (size_t)n);
  memset(lp, 255, sizeof(int) * (size_t)d);
  memset(ln, 255, sizeof(int) * (size_t)d);
  memset(rh, 255, sizeof(int) * (size_t)d);
  memset(nb, 255, sizeof(int) * (size_t)n);
  memset(rp, 255, sizeof(int) * (size_t)n);
  memset(rn, 255, sizeof(int) * (size_t)n);
  U used = 0;
  while (q--) {
    char op;
    int u;
    scanf(" %c%d", &op, &u);
    u--;
    if (op == 'G') {
      if (nb[u] < 0)
        puts("MISS");
      else {
        touch(nb[u]);
        printf("HIT %d\n", nb[u] + 1);
      }
      continue;
    }
    int x;
    scanf("%d", &x);
    x--;
    detach(u);
    if (sz[x] > cap)
      continue;
    if (!cached[x])
      used += sz[x];
    touch(x);
    attach(u, x);
    while (used > cap) {
      int dead = head;
      lr(dead);
      cached[dead] = 0;
      used -= sz[dead];
      for (int v = rh[dead]; v >= 0;) {
        int z = rn[v];
        nb[v] = rp[v] = rn[v] = -1;
        v = z;
      }
      rh[dead] = -1;
    }
  }
  return 0;
}
