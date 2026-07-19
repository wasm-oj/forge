#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
static int64_t rmq(int64_t *t, int b, int l, int r) {
  int64_t z = 0;
  for (l = b + l - 1, r = b + r - 1; l <= r; l >>= 1, r >>= 1) {
    if (l & 1) {
      if (t[l] > z)
        z = t[l];
      l++;
    }
    if (!(r & 1)) {
      if (t[r] > z)
        z = t[r];
      r--;
    }
  }
  return z;
}
int main(void) {
  int n, q;
  if (scanf("%d %d", &n, &q) != 2)
    return 0;
  int *nb = malloc((n + 2) * sizeof(int));
  int *bad = calloc(n + 1, sizeof(int));
  int *unk = calloc((size_t)4 * (n + 1), sizeof(int));
  int64_t *sum = calloc((size_t)2 * (n + 1), sizeof(int64_t));
  int b = 1;
  while (b < n)
    b <<= 1;
  int64_t *tm = calloc((size_t)2 * b, sizeof(int64_t)),
          *tv = calloc((size_t)2 * b, sizeof(int64_t));
  for (int i = 1; i <= n; i++) {
    int v;
    int64_t x[4];
    scanf("%d %" SCNd64 " %" SCNd64 " %" SCNd64 " %" SCNd64, &v, &x[0], &x[1],
          &x[2], &x[3]);
    bad[i] = v;
    for (int j = 0; j < 4; j++)
      unk[j * (n + 1) + i] = unk[j * (n + 1) + i - 1] + (x[j] < 0);
    for (int j = 0; j < 2; j++)
      sum[j * (n + 1) + i] = sum[j * (n + 1) + i - 1] + (x[j] < 0 ? 0 : x[j]);
    tm[b + i - 1] = x[2] < 0 ? 0 : x[2];
    tv[b + i - 1] = x[3] < 0 ? 0 : x[3];
  }
  for (int i = b - 1; i; i--) {
    tm[i] = tm[i * 2] > tm[i * 2 + 1] ? tm[i * 2] : tm[i * 2 + 1];
    tv[i] = tv[i * 2] > tv[i * 2 + 1] ? tv[i * 2] : tv[i * 2 + 1];
  }
  nb[n + 1] = n + 1;
  for (int i = n; i; i--)
    nb[i] = bad[i] ? i : nb[i + 1];
  while (q--) {
    int l, r, f;
    scanf("%d %d %d", &l, &r, &f);
    int e = f && nb[l] <= r ? nb[l] : r;
    printf("%d %d", e - l + 1, nb[l] <= e ? bad[nb[l]] : 0);
    for (int j = 0; j < 2; j++) {
      int *u = unk + j * (n + 1);
      int64_t *s = sum + j * (n + 1);
      if (u[e] - u[l - 1])
        printf(" null");
      else
        printf(" %" PRId64, s[e] - s[l - 1]);
    }
    for (int j = 2; j < 4; j++) {
      int *u = unk + j * (n + 1);
      if (u[e] - u[l - 1])
        printf(" null");
      else
        printf(" %" PRId64, rmq(j == 2 ? tm : tv, b, l, e));
    }
    putchar('\n');
  }
  free(nb);
  free(bad);
  free(unk);
  free(sum);
  free(tm);
  free(tv);
}
