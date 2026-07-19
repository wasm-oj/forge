#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {
  char d[9];
  int64_t x, y;
} Blob;
int main(void) {
  int b, r;
  if (scanf("%d %d", &b, &r) != 2)
    return 0;
  Blob *a = malloc((size_t)b * sizeof(*a));
  char (*q)[9] = malloc((size_t)r * 9);
  for (int i = 0; i < b; i++)
    scanf("%8s %" SCNd64 " %" SCNd64, a[i].d, &a[i].x, &a[i].y);
  for (int i = 0; i < r; i++)
    scanf("%8s", q[i]);
  for (int i = 1; i < b; i++)
    if (strcmp(a[i].d, a[i - 1].d) <= 0) {
      printf("INVALID BLOB_ORDER %d\n", i + 1);
      goto end;
    }
  for (int i = 0; i < b; i++)
    if (a[i].x != a[i].y) {
      printf("INVALID LENGTH %d\n", i + 1);
      goto end;
    }
  for (int i = 1; i < r; i++)
    if (strcmp(q[i], q[i - 1]) <= 0) {
      printf("INVALID REF_ORDER %d\n", i + 1);
      goto end;
    }
  int j = 0;
  for (int i = 0; i < r; i++) {
    while (j < b && strcmp(a[j].d, q[i]) < 0)
      j++;
    if (j == b || strcmp(a[j].d, q[i])) {
      printf("INVALID MISSING %d\n", i + 1);
      goto end;
    }
    j++;
  }
  j = 0;
  int64_t total = 0;
  for (int i = 0; i < r; i++) {
    while (strcmp(a[j].d, q[i]) < 0)
      j++;
    total += a[j++].y;
  }
  printf("VALID %" PRId64 "\n", total);
end:
  free(a);
  free(q);
}
