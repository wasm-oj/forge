#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int pc(uint64_t x) {
  int c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}
int main(void) {
  int n, h, m, q;
  if (scanf("%d%d%d%d", &n, &h, &m, &q) != 4)
    return 0;
  int w = (n + 63) / 64;
  uint64_t *b = calloc((size_t)h * w, sizeof(uint64_t)),
           *v = malloc(sizeof(uint64_t) * (size_t)w);
  for (int i = 0; i < m; i++) {
    int s, x;
    scanf("%d%d", &s, &x);
    b[(size_t)(x - 1) * w + (s - 1) / 64] |= UINT64_C(1) << ((s - 1) % 64);
  }
  while (q--) {
    memset(v, 0, sizeof(uint64_t) * (size_t)w);
    int k;
    scanf("%d", &k);
    while (k--) {
      int x;
      scanf("%d", &x);
      uint64_t *z = b + (size_t)(x - 1) * w;
      for (int j = 0; j < w; j++)
        v[j] |= z[j];
    }
    int ans = 0;
    for (int j = 0; j < w; j++)
      ans += pc(v[j]);
    printf("%d\n", ans);
  }
  return 0;
}
