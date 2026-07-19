#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  char *key;
  int job;
} Slot;
typedef struct {
  char *key;
  int epoch;
  unsigned char kind, alive;
} Job;
static uint64_t hash_key(const char *s) {
  uint64_t h = 1469598103934665603ULL;
  while (*s) {
    h ^= (unsigned char)*s++;
    h *= 1099511628211ULL;
  }
  return h;
}
int main(void) {
  int n;
  if (scanf("%d", &n) != 1)
    return 0;
  size_t cap = 1;
  while (cap < (size_t)n * 3)
    cap <<= 1;
  Slot *tab = calloc(cap, sizeof(*tab));
  Job *jobs = calloc((size_t)n + 1, sizeof(*jobs));
  int made = 0, epoch = 0, live_bg = 0;
  char op[2], key[21];
  for (int z = 0; z < n; z++) {
    scanf("%1s", op);
    if (op[0] == 'B' || op[0] == 'F') {
      scanf("%20s", key);
      size_t i = (size_t)hash_key(key) & (cap - 1);
      while (tab[i].key && strcmp(tab[i].key, key))
        i = (i + 1) & (cap - 1);
      if (!tab[i].key) {
        size_t len = strlen(key) + 1;
        tab[i].key = malloc(len);
        memcpy(tab[i].key, key, len);
      }
      int id = tab[i].job,
          ok = id && jobs[id].alive &&
               (jobs[id].kind == 'F' || jobs[id].epoch == epoch);
      if (ok)
        printf("JOIN %d\n", id);
      else {
        id = ++made;
        jobs[id] = (Job){tab[i].key, epoch, (unsigned char)op[0], 1};
        tab[i].job = id;
        if (op[0] == 'B')
          live_bg++;
        printf("NEW %d\n", id);
      }
    } else if (op[0] == 'S') {
      printf("CANCEL %d\n", live_bg);
      live_bg = 0;
      epoch++;
    } else {
      int id;
      scanf("%d", &id);
      int ok = id <= made && jobs[id].alive &&
               (jobs[id].kind == 'F' || jobs[id].epoch == epoch);
      if (!ok) {
        puts("STALE");
        continue;
      }
      jobs[id].alive = 0;
      if (jobs[id].kind == 'B')
        live_bg--;
      size_t i = (size_t)hash_key(jobs[id].key) & (cap - 1);
      while (strcmp(tab[i].key, jobs[id].key))
        i = (i + 1) & (cap - 1);
      if (tab[i].job == id)
        tab[i].job = 0;
      puts("DONE");
    }
  }
  for (size_t i = 0; i < cap; i++)
    free(tab[i].key);
  free(tab);
  free(jobs);
  return 0;
}
