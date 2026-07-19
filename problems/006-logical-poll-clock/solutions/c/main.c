#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {
  uint64_t d;
  int id;
} Item;
static int less(Item a, Item b) {
  return a.d < b.d || (a.d == b.d && a.id < b.id);
}
static void push(Item *h, int *n, Item x) {
  int i = (*n)++;
  while (i && less(x, h[(i - 1) / 2])) {
    h[i] = h[(i - 1) / 2];
    i = (i - 1) / 2;
  }
  h[i] = x;
}
static Item pop(Item *h, int *n) {
  Item r = h[0], x = h[--*n];
  int i = 0;
  while (i * 2 + 1 < *n) {
    int c = i * 2 + 1;
    if (c + 1 < *n && less(h[c + 1], h[c]))
      c++;
    if (!less(h[c], x))
      break;
    h[i] = h[c];
    i = c;
  }
  if (*n)
    h[i] = x;
  return r;
}
int main(void) {
  int N;
  if (scanf("%d", &N) != 1)
    return 0;
  Item *h = malloc((size_t)N * sizeof(*h));
  int *ids = malloc((size_t)N * sizeof(*ids));
  unsigned char *active = calloc(N + 1, 1);
  int hn = 0;
  uint64_t clock = 0;
  for (int z = 0; z < N; z++) {
    char op[2];
    scanf("%1s", op);
    if (op[0] == 'T') {
      int id;
      unsigned long long d;
      scanf("%d%llu", &id, &d);
      active[id] = 1;
      push(h, &hn, (Item){d, id});
    } else if (op[0] == 'C') {
      int id;
      scanf("%d", &id);
      active[id] = 0;
    } else {
      int ready;
      scanf("%d", &ready);
      while (hn && !active[h[0].id])
        pop(h, &hn);
      if (!ready && hn && h[0].d > clock)
        clock = h[0].d;
      int k = 0;
      while (hn && h[0].d <= clock) {
        Item x = pop(h, &hn);
        if (active[x.id]) {
          active[x.id] = 0;
          ids[k++] = x.id;
        }
      }
      printf("%llu %d %d", (unsigned long long)clock, ready, k);
      for (int i = 0; i < k; i++)
        printf(" %d", ids[i]);
      putchar('\n');
    }
  }
  free(h);
  free(ids);
  free(active);
}
