#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {
  char p[121], v[21];
} Field;
typedef struct {
  char id[21];
  uint64_t time;
  int n;
  Field *f;
} Case;
typedef struct {
  char name[21];
  int n;
  Case *c;
} Host;
static int cmpu(const void *a, const void *b) {
  uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b;
  return x < y ? -1 : x > y;
}
static char *diff(const char *c, const char *p) {
  size_t n = strlen(c) + strlen(p) + 2;
  char *s = malloc(n);
  snprintf(s, n, "%s.%s", c, p);
  return s;
}
int main(void) {
  int H;
  if (scanf("%d", &H) != 1)
    return 0;
  Host *h = calloc(H, sizeof(*h));
  for (int z = 0; z < H; z++) {
    scanf("%20s %d", h[z].name, &h[z].n);
    h[z].c = calloc(h[z].n, sizeof(Case));
    for (int i = 0; i < h[z].n; i++) {
      Case *x = &h[z].c[i];
      scanf("%20s %" SCNu64 " %d", x->id, &x->time, &x->n);
      x->f = calloc(x->n, sizeof(Field));
      for (int j = 0; j < x->n; j++)
        scanf("%120s %20s", x->f[j].p, x->f[j].v);
    }
  }
  int all = 1;
  for (int z = 1; z < H; z++) {
    int order = h[z].n != h[0].n;
    for (int i = 0; !order && i < h[0].n; i++)
      order = strcmp(h[z].c[i].id, h[0].c[i].id) != 0;
    if (order) {
      printf("HOST %s CASE_ORDER\n", h[z].name);
      all = 0;
      continue;
    }
    size_t cap = 0;
    for (int i = 0; i < h[0].n; i++)
      cap += (size_t)h[0].c[i].n + h[z].c[i].n;
    char **d = malloc(cap * sizeof(*d));
    int nd = 0;
    for (int i = 0; i < h[0].n; i++) {
      Case *a = &h[0].c[i], *b = &h[z].c[i];
      int x = 0, y = 0;
      while (x < a->n || y < b->n) {
        if (y == b->n || (x < a->n && strcmp(a->f[x].p, b->f[y].p) < 0))
          d[nd++] = diff(a->id, a->f[x++].p);
        else if (x == a->n || strcmp(a->f[x].p, b->f[y].p) > 0)
          d[nd++] = diff(a->id, b->f[y++].p);
        else {
          if (strcmp(a->f[x].v, b->f[y].v))
            d[nd++] = diff(a->id, a->f[x].p);
          x++;
          y++;
        }
      }
    }
    if (!nd)
      printf("HOST %s OK\n", h[z].name);
    else {
      all = 0;
      printf("HOST %s %d", h[z].name, nd);
      for (int i = 0; i < nd; i++)
        printf(" %s", d[i]);
      putchar('\n');
    }
    for (int i = 0; i < nd; i++)
      free(d[i]);
    free(d);
  }
  if (all)
    for (int i = 0; i < h[0].n; i++) {
      uint64_t *x = malloc((size_t)H * sizeof(*x));
      for (int z = 0; z < H; z++)
        x[z] = h[z].c[i].time;
      qsort(x, H, sizeof(*x), cmpu);
      printf("MEDIAN %s %" PRIu64 "\n", h[0].c[i].id, x[(H - 1) / 2]);
      free(x);
    }
  for (int z = 0; z < H; z++) {
    for (int i = 0; i < h[z].n; i++)
      free(h[z].c[i].f);
    free(h[z].c);
  }
  free(h);
}
