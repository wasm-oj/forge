#include <ctype.h>
#include <stdio.h>
#include <string.h>
typedef unsigned long long U;
int pathok(const char *s) {
  if (!*s || *s == '/' || s[strlen(s) - 1] == '/')
    return 0;
  const char *p = s, *q;
  while (*p) {
    q = strchr(p, '/');
    size_t n = q ? (size_t)(q - p) : strlen(p);
    if (!n || (n == 1 && p[0] == '.') || (n == 2 && p[0] == '.' && p[1] == '.'))
      return 0;
    for (size_t i = 0; i < n; i++)
      if (!(islower((unsigned char)p[i]) || isdigit((unsigned char)p[i]) ||
            p[i] == '.' || p[i] == '_' || p[i] == '-'))
        return 0;
    if (!q)
      break;
    p = q + 1;
  }
  return 1;
}
int main(void) {
  int n;
  U limn, limb;
  if (scanf("%d %llu %llu", &n, &limn, &limb) != 3)
    return 0;
  U off = 0, cnt = 0, used = 0;
  char pending[201] = "";
  for (int i = 1; i <= n; i++) {
    U got, size, a, b;
    char t, name[201], *err = NULL;
    scanf("%llu %c %200s %llu %llu %llu", &got, &t, name, &size, &a, &b);
    if (got != off)
      err = "OFFSET";
    else if (a != b)
      err = "CHECKSUM";
    else if (!strchr("FDGP", t))
      err = "TYPE";
    else if ((t == 'G' || t == 'P') && *pending)
      err = "STATE";
    else if ((t == 'G' || t == 'P') && size != strlen(name) + 1)
      err = "META_SIZE";
    else if ((t == 'G' || t == 'P') && !pathok(name))
      err = "PATH";
    else if ((t == 'F' || t == 'D') && !pathok(*pending ? pending : name))
      err = "PATH";
    else if (t == 'D' && size)
      err = "ENTRY_SIZE";
    else if (t == 'F' && (cnt == limn || size > limb - used))
      err = "LIMIT";
    if (err) {
      printf("REJECT %d %s\n", i, err);
      return 0;
    }
    off += 512 + ((size + 511) / 512) * 512;
    if (t == 'G' || t == 'P')
      strcpy(pending, name);
    else {
      pending[0] = 0;
      if (t == 'F') {
        cnt++;
        used += size;
      }
    }
  }
  if (*pending)
    printf("REJECT %d STATE\n", n + 1);
  else
    printf("ACCEPT %llu %llu %llu\n", cnt, used, off);
  return 0;
}
