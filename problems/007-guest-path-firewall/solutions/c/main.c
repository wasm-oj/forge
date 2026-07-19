#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
  int n;
  if (scanf("%d", &n) != 1)
    return 0;
  char *s = malloc(200001);
  int *st = malloc(200001 * sizeof(*st)), *ln = malloc(200001 * sizeof(*ln));
  while (n--) {
    scanf("%200000s", s);
    int top = 0, bad = 0, L = (int)strlen(s), start = 1;
    for (int i = 1; i <= L; i++)
      if (i == L || s[i] == '/') {
        int len = i - start;
        if (len == 0 || (len == 1 && s[start] == '.')) {
        } else if (len == 2 && s[start] == '.' && s[start + 1] == '.') {
          if (!top) {
            bad = 1;
            break;
          }
          top--;
        } else {
          st[top] = start;
          ln[top] = len;
          top++;
        }
        start = i + 1;
      }
    if (bad)
      puts("INVALID");
    else {
      if (!top)
        puts("/");
      else {
        for (int i = 0; i < top; i++) {
          putchar('/');
          fwrite(s + st[i], 1, (size_t)ln[i], stdout);
        }
        putchar('\n');
      }
    }
  }
  free(s);
  free(st);
  free(ln);
}
