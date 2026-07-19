#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef struct {
  char t;
  int64_t k;
} Act;
typedef struct {
  Act *a;
  int n, pc, closed;
} Prog;
static int64_t C, occ[2], steps;
static int one(Prog *p, int w) {
  if (p[w].pc == p[w].n)
    return 2;
  Act x = p[w].a[p[w].pc];
  int o = 1 - w;
  if (x.t == 'W') {
    if (C - occ[w] < x.k)
      return 0;
    occ[w] += x.k;
  } else if (x.t == 'R') {
    if (occ[o] < x.k)
      return p[o].closed ? -1 : 0;
    occ[o] -= x.k;
  } else
    p[w].closed = 1;
  p[w].pc++;
  steps++;
  if (p[w].pc == p[w].n)
    p[w].closed = 1;
  return 1;
}
int main(void) {
  int na, nb;
  if (scanf("%" SCNd64 " %d %d", &C, &na, &nb) != 3)
    return 0;
  Prog p[2] = {{calloc(na, sizeof(Act)), na, 0, na == 0},
               {calloc(nb, sizeof(Act)), nb, 0, nb == 0}};
  for (int w = 0; w < 2; w++)
    for (int i = 0; i < p[w].n; i++) {
      scanf(" %c", &p[w].a[i].t);
      if (p[w].a[i].t != 'C')
        scanf("%" SCNd64, &p[w].a[i].k);
    }
  for (;;) {
    if (p[0].pc == na && p[1].pc == nb) {
      printf("SUCCESS %" PRId64 " %" PRId64 " %" PRId64 "\n", steps, occ[0],
             occ[1]);
      break;
    }
    int progress = 0;
    for (int w = 0; w < 2; w++) {
      int z = one(p, w);
      if (z < 0) {
        printf("FAIL %c %" PRId64 " %" PRId64 " %" PRId64 "\n", w ? 'B' : 'A',
               steps, occ[0], occ[1]);
        free(p[0].a);
        free(p[1].a);
        return 0;
      }
      if (z == 1)
        progress = 1;
    }
    if (!progress) {
      printf("DEADLOCK %" PRId64 " %" PRId64 " %" PRId64 "\n", steps, occ[0],
             occ[1]);
      break;
    }
  }
  free(p[0].a);
  free(p[1].a);
}
