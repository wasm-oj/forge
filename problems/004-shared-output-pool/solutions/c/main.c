#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int n, q;
  if (scanf("%d%d", &n, &q) != 2)
    return 0;
  char *s = malloc((size_t)n);
  uint64_t *a = malloc((size_t)n * sizeof(*a));
  for (int i = 0; i < n; i++) {
    char x[2];
    unsigned long long v;
    scanf("%1s%llu", x, &v);
    s[i] = x[0];
    a[i] = v;
  }
  int i = 0;
  uint64_t used = 0, c[3] = {0};
  while (q--) {
    unsigned long long b;
    scanf("%llu", &b);
    while (i < n && a[i] <= b - used) {
      used += a[i];
      int k = s[i] == 'O' ? 0 : s[i] == 'E' ? 1 : 2;
      c[k] += a[i];
      i++;
    }
    uint64_t d[3] = {c[0], c[1], c[2]};
    int fail = 0;
    if (i < n) {
      fail = i + 1;
      int k = s[i] == 'O' ? 0 : s[i] == 'E' ? 1 : 2;
      d[k] += b - used;
    }
    printf("%d %llu %llu %llu\n", fail, (unsigned long long)d[0],
           (unsigned long long)d[1], (unsigned long long)d[2]);
  }
  free(s);
  free(a);
}
