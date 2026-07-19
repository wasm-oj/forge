#include <stdio.h>
#include <string.h>
typedef unsigned long long U;
int main(void) {
  int n;
  if (scanf("%d", &n) != 1)
    return 0;
  U b, used = 0;
  scanf("%llu", &b);
  char cur[21] = "";
  int gen = 0, reject = 0;
  while (n--) {
    char f[21];
    U s;
    scanf("%20s%llu", f, &s);
    if (!s) {
      puts("CACHE");
      continue;
    }
    if (s > 8 || s > b) {
      puts("REJECT");
      reject++;
      continue;
    }
    if (strcmp(cur, f) || used + s > b) {
      strcpy(cur, f);
      used = 0;
      gen++;
    }
    used += s;
    printf("WORKER %d\n", gen);
  }
  printf("SUMMARY %d %d\n", gen, reject);
  return 0;
}
