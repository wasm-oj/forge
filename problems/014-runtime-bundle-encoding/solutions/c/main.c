#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {
  char t, *p, *v;
} R;
int cmp(const void *a, const void *b) {
  return strcmp(((const R *)a)->p, ((const R *)b)->p);
}
void hx(const char *s) {
  for (; *s; s++)
    printf("%02x", (unsigned char)*s);
}
int main(void) {
  int n;
  if (scanf("%d", &n) != 1)
    return 0;
  R *a = malloc(sizeof(R) * (size_t)n);
  char *tmp = malloc(400001);
  for (int i = 0; i < n; i++) {
    char path[101];
    scanf(" %c %100s %400000s", &a[i].t, path, tmp);
    a[i].p = malloc(strlen(path) + 1);
    a[i].v = malloc(strlen(tmp) + 1);
    strcpy(a[i].p, path);
    strcpy(a[i].v, tmp);
  }
  qsort(a, (size_t)n, sizeof(R), cmp);
  printf("574f424a%08x", (unsigned)n);
  for (int i = 0; i < n; i++) {
    size_t z = !strcmp(a[i].v, "-")
                   ? 0
                   : (a[i].t == 'T' ? strlen(a[i].v) : strlen(a[i].v) / 2);
    fputs(a[i].t == 'T' ? "01" : "02", stdout);
    printf("%08x", (unsigned)strlen(a[i].p));
    hx(a[i].p);
    printf("%016llx", (unsigned long long)z);
    if (z) {
      if (a[i].t == 'T')
        hx(a[i].v);
      else
        printf("%s", a[i].v);
    }
  }
  putchar('\n');
  return 0;
}
