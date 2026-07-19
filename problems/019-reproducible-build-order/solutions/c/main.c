#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {
  char *s;
  int id;
} E;
static E *mapv;
static char (*namev)[31];
int ec(const void *a, const void *b) {
  return strcmp(((const E *)a)->s, ((const E *)b)->s);
}
int findid(const char *s, int n) {
  int l = 0, r = n;
  while (l < r) {
    int m = (l + r) / 2, c = strcmp(mapv[m].s, s);
    if (c < 0)
      l = m + 1;
    else
      r = m;
  }
  return l < n && !strcmp(mapv[l].s, s) ? mapv[l].id : -1;
}
int less(int a, int b) { return strcmp(namev[a], namev[b]) < 0; }
void push(int *h, int *z, int x) {
  int i = (*z)++;
  h[i] = x;
  while (i) {
    int p = (i - 1) / 2;
    if (!less(h[i], h[p]))
      break;
    int t = h[i];
    h[i] = h[p];
    h[p] = t;
    i = p;
  }
}
int pop(int *h, int *z) {
  int ans = h[0], x = h[--*z], i = 0;
  if (*z)
    h[0] = x;
  for (;;) {
    int l = i * 2 + 1, r = l + 1, b = i;
    if (l < *z && less(h[l], h[b]))
      b = l;
    if (r < *z && less(h[r], h[b]))
      b = r;
    if (b == i)
      break;
    int t = h[i];
    h[i] = h[b];
    h[b] = t;
    i = b;
  }
  return ans;
}
int main(void) {
  int n, m;
  if (scanf("%d%d", &n, &m) != 2)
    return 0;
  namev = malloc(sizeof(*namev) * (size_t)n);
  mapv = malloc(sizeof(E) * (size_t)n);
  for (int i = 0; i < n; i++) {
    scanf("%30s", namev[i]);
    mapv[i] = (E){namev[i], i};
  }
  qsort(mapv, (size_t)n, sizeof(E), ec);
  int *head = malloc(sizeof(int) * (size_t)n),
      *to = malloc(sizeof(int) * (size_t)(m ? m : 1)),
      *next = malloc(sizeof(int) * (size_t)(m ? m : 1)),
      *deg = calloc((size_t)n, sizeof(int));
  for (int i = 0; i < n; i++)
    head[i] = -1;
  int bad = 0;
  for (int i = 0; i < m; i++) {
    char a[31], b[31];
    scanf("%30s%30s", a, b);
    int x = findid(a, n), y = findid(b, n);
    if ((x < 0 || y < 0) && !bad)
      bad = i + 1;
    if (x >= 0 && y >= 0) {
      to[i] = x;
      next[i] = head[y];
      head[y] = i;
      deg[x]++;
    }
  }
  if (bad) {
    printf("INVALID DANGLING %d\n", bad);
    return 0;
  }
  int *h = malloc(sizeof(int) * (size_t)n), z = 0,
      *out = malloc(sizeof(int) * (size_t)n), k = 0;
  for (int i = 0; i < n; i++)
    if (!deg[i])
      push(h, &z, i);
  while (z) {
    int u = pop(h, &z);
    out[k++] = u;
    for (int e = head[u]; e >= 0; e = next[e])
      if (!--deg[to[e]])
        push(h, &z, to[e]);
  }
  if (k < n)
    puts("INVALID CYCLE");
  else {
    printf("ORDER");
    for (int i = 0; i < n; i++)
      printf(" %s", namev[out[i]]);
    putchar('\n');
  }
  return 0;
}
