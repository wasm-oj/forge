#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {
  char *p;
  uint64_t m, a;
} File;
static int cmp(const void *x, const void *y) {
  return strcmp(((const File *)x)->p, ((const File *)y)->p);
}
int main(void) {
  int N, Q;
  unsigned long long U;
  if (scanf("%d%d%llu", &N, &Q, &U) != 3)
    return 0;
  File *f = malloc((size_t)N * sizeof(*f));
  char *buf = malloc(200001);
  for (int i = 0; i < N; i++) {
    unsigned long long m, a;
    scanf("%200000s%llu%llu", buf, &m, &a);
    f[i].p = malloc(strlen(buf) + 1);
    strcpy(f[i].p, buf);
    f[i].m = m;
    f[i].a = a;
  }
  qsort(f, (size_t)N, sizeof(*f), cmp);
  uint64_t *pre = calloc(N + 1, sizeof(*pre));
  int mismatch = N;
  for (int i = 0; i < N; i++) {
    pre[i + 1] = pre[i] + f[i].m;
    if (mismatch == N && f[i].m != f[i].a)
      mismatch = i;
  }
  int k = 0;
  while (Q--) {
    unsigned long long b;
    scanf("%llu", &b);
    if (b < U) {
      puts("ERR QUOTA -");
      continue;
    }
    uint64_t cap = b - U;
    while (k < N && pre[k + 1] <= cap)
      k++;
    if (k < mismatch)
      printf("ERR QUOTA %s\n", f[k].p);
    else if (mismatch < N)
      printf("ERR MISMATCH %s\n", f[mismatch].p);
    else if (k < N)
      printf("ERR QUOTA %s\n", f[k].p);
    else
      printf("OK %d %llu\n", N, (unsigned long long)(U + pre[N]));
  }
  for (int i = 0; i < N; i++)
    free(f[i].p);
  free(f);
  free(buf);
  free(pre);
}
