#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
  int F, N;
  unsigned long long B;
  if (scanf("%d%d%llu", &F, &N, &B) != 3)
    return 0;
  uint64_t *sz = calloc(F + 1, sizeof(*sz)), *cur = calloc(F + 1, sizeof(*cur));
  uint64_t used = 0, peak = 0;
  while (N--) {
    char op[9];
    int x;
    unsigned long long v;
    scanf("%8s%d%llu", op, &x, &v);
    int err = 0;
    if (strcmp(op, "SEEK") == 0)
      cur[x] = v;
    else {
      uint64_t newsize =
          strcmp(op, "WRITE") == 0
              ? (v ? (cur[x] + v > sz[x] ? cur[x] + v : sz[x]) : sz[x])
              : v;
      if (newsize > sz[x] && newsize - sz[x] > B - used)
        err = 1;
      else {
        if (newsize >= sz[x])
          used += newsize - sz[x];
        else
          used -= sz[x] - newsize;
        sz[x] = newsize;
        if (strcmp(op, "WRITE") == 0 && v)
          cur[x] += v;
      }
    }
    if (used > peak)
      peak = used;
    printf("%s %llu %llu %llu\n", err ? "ERR QUOTA" : "OK",
           (unsigned long long)sz[x], (unsigned long long)cur[x],
           (unsigned long long)used);
  }
  printf("SUMMARY %llu %llu\n", (unsigned long long)used,
         (unsigned long long)peak);
  free(sz);
  free(cur);
}
