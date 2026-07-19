#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  char key[33];
  int last_index;
} Entry;

static uint64_t hash_token(const char *token) {
  uint64_t hash = UINT64_C(14695981039346656037);
  while (*token != '\0') {
    hash ^= (unsigned char)*token++;
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

int main(void) {
  int n, k;
  if (scanf("%d%d", &n, &k) != 2)
    return 0;

  size_t capacity = 1;
  while (capacity < (size_t)n * 2)
    capacity <<= 1;
  Entry *table = calloc(capacity, sizeof(*table));
  if (table == NULL)
    return 1;

  int hits = 0;
  for (int index = 1; index <= n; index++) {
    char token[33];
    if (scanf("%32s", token) != 1) {
      free(table);
      return 0;
    }
    size_t slot = (size_t)hash_token(token) & (capacity - 1);
    while (table[slot].last_index != 0 && strcmp(table[slot].key, token) != 0)
      slot = (slot + 1) & (capacity - 1);
    if (table[slot].last_index != 0) {
      if (index - table[slot].last_index <= k)
        hits++;
    } else {
      strcpy(table[slot].key, token);
    }
    table[slot].last_index = index;
  }

  printf("%d\n", hits);
  free(table);
  return 0;
}
