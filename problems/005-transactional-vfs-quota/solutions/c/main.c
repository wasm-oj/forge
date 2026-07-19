#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
  int P, N, I;
  if (scanf("%d%d", &P, &N) != 2)
    return 0;
  unsigned long long B;
  scanf("%llu%d", &B, &I);
  unsigned char *ex = calloc(P + 1, 1);
  uint64_t *sz = calloc(P + 1, sizeof(*sz));
  uint64_t used = 0, peakb = 0;
  int ino = 0, peaki = 0, sticky = 0;
  for (int z = 0; z < N; z++) {
    char op[10];
    int x;
    scanf("%9s%d", op, &x);
    const char *err = NULL;
    if (strcmp(op, "CREATE") == 0) {
      if (ex[x])
        err = "EXISTS";
      else if (ino == I)
        err = "INODES";
      else {
        ex[x] = 1;
        sz[x] = 0;
        ino++;
      }
    } else if (strcmp(op, "UNLINK") == 0) {
      if (!ex[x])
        err = "NOENT";
      else {
        used -= sz[x];
        sz[x] = 0;
        ex[x] = 0;
        ino--;
      }
    } else {
      uint64_t newsize;
      if (strcmp(op, "WRITE") == 0) {
        unsigned long long off, len;
        scanf("%llu%llu", &off, &len);
        newsize = !len ? sz[x] : (off + len > sz[x] ? off + len : sz[x]);
      } else {
        unsigned long long v;
        scanf("%llu", &v);
        newsize = v;
      }
      if (!ex[x])
        err = "NOENT";
      else if (newsize > sz[x] && newsize - sz[x] > B - used)
        err = "BYTES";
      else {
        if (newsize >= sz[x])
          used += newsize - sz[x];
        else
          used -= sz[x] - newsize;
        sz[x] = newsize;
      }
    }
    if (err) {
      printf("ERR %s\n", err);
      if (strcmp(err, "BYTES") == 0 || strcmp(err, "INODES") == 0)
        sticky = 1;
    } else
      puts("OK");
    if (used > peakb)
      peakb = used;
    if (ino > peaki)
      peaki = ino;
  }
  printf("SUMMARY %llu %d %llu %d %d\n", (unsigned long long)used, ino,
         (unsigned long long)peakb, peaki, sticky);
  free(ex);
  free(sz);
}
