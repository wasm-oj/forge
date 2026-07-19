#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {
  int64_t size, last;
  int pri;
  char p[21], k[21];
} Item;
static int cmp(const void *A, const void *B) {
  const Item *a = A, *b = B;
  if (a->pri != b->pri)
    return a->pri < b->pri ? -1 : 1;
  if (a->last != b->last)
    return a->last < b->last ? -1 : 1;
  int z = strcmp(a->p, b->p);
  return z ? z : strcmp(a->k, b->k);
}
int main(void) {
  int n;
  int64_t C, A, R;
  if (scanf("%d %" SCNd64 " %" SCNd64 " %" SCNd64, &n, &C, &A, &R) != 4)
    return 0;
  Item *x = malloc((size_t)n * sizeof(*x));
  int64_t total = 0;
  for (int i = 0; i < n; i++) {
    scanf("%" SCNd64 " %d %" SCNd64 " %20s %20s", &x[i].size, &x[i].pri,
          &x[i].last, x[i].p, x[i].k);
    total += x[i].size;
  }
  int64_t need = total - C;
  if (need < 0)
    need = 0;
  if (R > A && R - A > need)
    need = R - A;
  if (need > total) {
    puts("IMPOSSIBLE");
    free(x);
    return 0;
  }
  qsort(x, n, sizeof(*x), cmp);
  int k = 0;
  int64_t freed = 0;
  while (freed < need)
    freed += x[k++].size;
  printf("%d %" PRId64 "\n", k, freed);
  for (int i = 0; i < k; i++)
    printf("%s %s\n", x[i].p, x[i].k);
  free(x);
}
