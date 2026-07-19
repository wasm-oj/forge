#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int n, m, c;
  if (scanf("%d%d%d", &n, &m, &c) != 3)
    return 0;
  int *head = malloc(sizeof(int) * (size_t)n),
      *to = malloc(sizeof(int) * (size_t)(m ? m : 1)),
      *next = malloc(sizeof(int) * (size_t)(m ? m : 1));
  for (int i = 0; i < n; i++)
    head[i] = -1;
  for (int i = 0; i < m; i++) {
    int u;
    scanf("%d%d", &u, &to[i]);
    u--;
    to[i]--;
    next[i] = head[u];
    head[u] = i;
  }
  unsigned char *d = calloc((size_t)n, 1);
  int *q = malloc(sizeof(int) * (size_t)n), l = 0, r = 0;
  for (int i = 0; i < c; i++) {
    int x;
    scanf("%d", &x);
    x--;
    if (!d[x]) {
      d[x] = 1;
      q[r++] = x;
    }
  }
  while (l < r) {
    int u = q[l++];
    for (int e = head[u]; e >= 0; e = next[e])
      if (!d[to[e]]) {
        d[to[e]] = 1;
        q[r++] = to[e];
      }
  }
  int k = 0;
  for (int i = 0; i < n; i++)
    k += d[i] != 0;
  printf("%d\n", k);
  int first = 1;
  for (int i = 0; i < n; i++)
    if (d[i]) {
      if (!first)
        putchar(' ');
      printf("%d", i + 1);
      first = 0;
    }
  putchar('\n');
  return 0;
}
