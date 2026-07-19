#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef unsigned long long U;
typedef struct {
  char d[65];
  U z;
} R;
int cmp(const void *a, const void *b) {
  return strcmp(((const R *)a)->d, ((const R *)b)->d);
}
int find(R *a, int n, const char *d) {
  int l = 0, r = n;
  while (l < r) {
    int m = (l + r) / 2;
    if (strcmp(a[m].d, d) < 0)
      l = m + 1;
    else
      r = m;
  }
  return l < n && !strcmp(a[l].d, d) ? l : -1;
}
int main(void) {
  int n, m;
  if (scanf("%d%d", &n, &m) != 2)
    return 0;
  R *l = malloc(sizeof(R) * (size_t)n), *p = malloc(sizeof(R) * (size_t)m),
    *req = malloc(sizeof(R) * (size_t)n);
  U total = 0;
  for (int i = 0; i < n; i++) {
    char name[31];
    scanf("%30s%64s%llu", name, l[i].d, &l[i].z);
    total += l[i].z;
  }
  for (int i = 0; i < m; i++)
    scanf("%64s%llu", p[i].d, &p[i].z);
  qsort(l, (size_t)n, sizeof(R), cmp);
  qsort(p, (size_t)m, sizeof(R), cmp);
  int u = 0;
  for (int i = 0; i < n;) {
    int j = i + 1;
    while (j < n && !strcmp(l[j].d, l[i].d)) {
      if (l[j].z != l[i].z) {
        printf("LOCK_CONFLICT %s\n", l[i].d);
        return 0;
      }
      j++;
    }
    req[u++] = l[i];
    i = j;
  }
  for (int i = 1; i < m; i++)
    if (!strcmp(p[i].d, p[i - 1].d)) {
      printf("DUPLICATE_PAYLOAD %s\n", p[i].d);
      return 0;
    }
  for (int i = 0; i < u; i++)
    if (find(p, m, req[i].d) < 0) {
      printf("MISSING %s\n", req[i].d);
      return 0;
    }
  for (int i = 0; i < m; i++)
    if (find(req, u, p[i].d) < 0) {
      printf("EXTRA %s\n", p[i].d);
      return 0;
    }
  for (int i = 0; i < u; i++) {
    int j = find(p, m, req[i].d);
    if (p[j].z != req[i].z) {
      printf("SIZE %s\n", req[i].d);
      return 0;
    }
  }
  U unique = 0;
  for (int i = 0; i < u; i++)
    unique += req[i].z;
  printf("VALID %d %llu %llu\n", u, unique, total - unique);
  return 0;
}
