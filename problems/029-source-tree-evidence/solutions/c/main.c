#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {
  char path[121];
  char *line;
} R;
static int cmp(const void *a, const void *b) {
  return strcmp(((const R *)a)->path, ((const R *)b)->path);
}
int main(void) {
  int n;
  char E[121], buf[512];
  if (scanf("%d %120s", &n, E) != 2)
    return 0;
  fgets(buf, sizeof(buf), stdin);
  R *a = malloc((size_t)n * sizeof(*a));
  int m = 0;
  size_t le = strlen(E);
  for (int i = 0; i < n; i++) {
    fgets(buf, sizeof(buf), stdin);
    buf[strcspn(buf, "\r\n")] = 0;
    char t;
    char p[121];
    sscanf(buf, "%c %120s", &t, p);
    if (!strcmp(p, E) || (!strncmp(p, E, le) && p[le] == '/'))
      continue;
    strcpy(a[m].path, p);
    size_t z = strlen(buf) + 1;
    a[m].line = malloc(z);
    memcpy(a[m].line, buf, z);
    m++;
  }
  qsort(a, m, sizeof(*a), cmp);
  printf("%d\n", m);
  for (int i = 0; i < m; i++) {
    puts(a[i].line);
    free(a[i].line);
  }
  free(a);
}
