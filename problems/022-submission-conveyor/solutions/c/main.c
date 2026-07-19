#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef struct {
  int key;
  unsigned char state;
} Slot;
static size_t locate(Slot *t, size_t m, int x) {
  size_t i = ((uint32_t)x * 2654435761u) & (m - 1);
  while (t[i].key && t[i].key != x)
    i = (i + 1) & (m - 1);
  return i;
}
int main(void) {
  int n;
  if (scanf("%d", &n) != 1)
    return 0;
  size_t m = 1;
  while (m < (size_t)n * 3)
    m <<= 1;
  Slot *t = calloc(m, sizeof(*t));
  int *q = malloc((size_t)n * sizeof(*q));
  int h = 0, z = 0, active = 0, waiting = 0;
  for (int e = 0; e < n; e++) {
    char op;
    scanf(" %c", &op);
    if (op == 'A') {
      int x;
      scanf("%d", &x);
      size_t i = locate(t, m, x);
      t[i].key = x;
      if (!active) {
        active = x;
        t[i].state = 2;
      } else {
        t[i].state = 1;
        q[z++] = x;
        waiting++;
      }
    } else if (op == 'C') {
      int x;
      scanf("%d", &x);
      size_t i = locate(t, m, x);
      if (t[i].key && t[i].state == 1) {
        t[i].state = 3;
        waiting--;
      } else if (t[i].key && t[i].state == 2) {
        t[i].state = 3;
        active = 0;
      }
    } else if (active) {
      size_t i = locate(t, m, active);
      t[i].state = 3;
      active = 0;
    }
    if (!active)
      while (h < z) {
        int x = q[h++];
        size_t i = locate(t, m, x);
        if (t[i].state == 1) {
          t[i].state = 2;
          active = x;
          waiting--;
          break;
        }
      }
    printf("%d %d\n", active, waiting);
  }
  free(t);
  free(q);
}
