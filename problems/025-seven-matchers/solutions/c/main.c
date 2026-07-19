#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void radix_sort(char **a, int n) {
  if (n < 2)
    return;
  char **tmp = malloc((size_t)n * sizeof(*tmp));
  for (int pos = 29; pos >= 0; pos--) {
    size_t next[257] = {0};
    for (int i = 0; i < n; i++) {
      size_t len = strlen(a[i]);
      unsigned key = (size_t)pos < len ? (unsigned char)a[i][pos] + 1U : 0U;
      next[key]++;
    }
    size_t offset = 0;
    for (int key = 0; key < 257; key++) {
      size_t count = next[key];
      next[key] = offset;
      offset += count;
    }
    for (int i = 0; i < n; i++) {
      size_t len = strlen(a[i]);
      unsigned key = (size_t)pos < len ? (unsigned char)a[i][pos] + 1U : 0U;
      tmp[next[key]++] = a[i];
    }
    memcpy(a, tmp, (size_t)n * sizeof(*a));
  }
  free(tmp);
}
static char *word(void) {
  char b[64];
  scanf("%63s", b);
  size_t n = strlen(b) + 1;
  char *s = malloc(n);
  memcpy(s, b, n);
  return s;
}
static int seq(char **a, int n, char **b, int m) {
  if (n != m)
    return 0;
  for (int i = 0; i < n; i++)
    if (strcmp(a[i], b[i]))
      return 0;
  return 1;
}
static int seteq(char **a, int n, char **b, int m) {
  int i = 0, j = 0;
  while (i < n && j < m) {
    if (strcmp(a[i], b[j]))
      return 0;
    char *x = a[i], *y = b[j];
    while (i < n && !strcmp(a[i], x))
      i++;
    while (j < m && !strcmp(b[j], y))
      j++;
  }
  return i == n && j == m;
}
int main(void) {
  int Q;
  if (scanf("%d", &Q) != 1)
    return 0;
  while (Q--) {
    char k[16];
    int n, m;
    int64_t eps = 0;
    scanf("%15s%d%d", k, &n, &m);
    if (!strcmp(k, "FLOAT"))
      scanf("%" SCNd64, &eps);
    int on = n, om = m;
    char **a = malloc((size_t)n * sizeof(*a)),
         **b = malloc((size_t)m * sizeof(*b));
    for (int i = 0; i < n; i++)
      a[i] = word();
    for (int i = 0; i < m; i++)
      b[i] = word();
    int ok = 0;
    if (!strcmp(k, "EXACT")) {
      size_t x = 0, y = 0;
      for (int i = 0; i < n; i++)
        x += strlen(a[i]);
      for (int i = 0; i < m; i++)
        y += strlen(b[i]);
      if (x == y) {
        char *A = malloc(x + 1), *B = malloc(y + 1), *p = A, *q = B;
        for (int i = 0; i < n; i++) {
          size_t z = strlen(a[i]);
          memcpy(p, a[i], z);
          p += z;
        }
        *p = 0;
        for (int i = 0; i < m; i++) {
          size_t z = strlen(b[i]);
          memcpy(q, b[i], z);
          q += z;
        }
        *q = 0;
        ok = !strcmp(A, B);
        free(A);
        free(B);
      }
    } else if (!strcmp(k, "LINES")) {
      while (n && strcmp(a[n - 1], "#") == 0)
        n--;
      while (m && strcmp(b[m - 1], "#") == 0)
        m--;
      ok = seq(a, n, b, m);
    } else if (!strcmp(k, "TOKENS"))
      ok = seq(a, n, b, m);
    else if (!strcmp(k, "FLOAT")) {
      ok = n == m;
      for (int i = 0; i < n && ok; i++) {
        int64_t x = strtoll(a[i], 0, 10), y = strtoll(b[i], 0, 10);
        uint64_t d =
            x >= y ? (uint64_t)x - (uint64_t)y : (uint64_t)y - (uint64_t)x;
        if (d > (uint64_t)eps)
          ok = 0;
      }
    } else {
      radix_sort(a, n);
      radix_sort(b, m);
      ok = !strcmp(k, "SET") ? seteq(a, n, b, m) : seq(a, n, b, m);
    }
    puts(ok ? "ACCEPT" : "WRONG");
    for (int i = 0; i < on; i++)
      free(a[i]);
    for (int i = 0; i < om; i++)
      free(b[i]);
    free(a);
    free(b);
  }
}
