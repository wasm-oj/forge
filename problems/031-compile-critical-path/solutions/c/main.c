#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

enum { MOD = 1000000007 };

int main(void) {
  int n, m;
  if (scanf("%d %d", &n, &m) != 2)
    return 1;
  int64_t *duration = malloc((size_t)n * sizeof(*duration));
  int64_t *best = calloc((size_t)n, sizeof(*best));
  int *ways = calloc((size_t)n, sizeof(*ways));
  int *head = malloc((size_t)n * sizeof(*head));
  int *indegree = calloc((size_t)n, sizeof(*indegree));
  int *outdegree = calloc((size_t)n, sizeof(*outdegree));
  int *queue = malloc((size_t)n * sizeof(*queue));
  int *to = malloc((size_t)(m > 0 ? m : 1) * sizeof(*to));
  int *next = malloc((size_t)(m > 0 ? m : 1) * sizeof(*next));
  if (!duration || !best || !ways || !head || !indegree || !outdegree ||
      !queue || !to || !next)
    return 1;
  for (int i = 0; i < n; ++i) {
    if (scanf("%" SCNd64, &duration[i]) != 1)
      return 1;
    head[i] = -1;
  }
  for (int edge = 0; edge < m; ++edge) {
    int u, v;
    if (scanf("%d %d", &u, &v) != 2)
      return 1;
    --u;
    --v;
    to[edge] = v;
    next[edge] = head[u];
    head[u] = edge;
    ++indegree[v];
    ++outdegree[u];
  }
  int front = 0, back = 0;
  for (int node = 0; node < n; ++node) {
    if (indegree[node] == 0) {
      best[node] = duration[node];
      ways[node] = 1;
      queue[back++] = node;
    }
  }
  while (front < back) {
    int node = queue[front++];
    for (int edge = head[node]; edge != -1; edge = next[edge]) {
      int target = to[edge];
      int64_t candidate = best[node] + duration[target];
      if (candidate > best[target]) {
        best[target] = candidate;
        ways[target] = ways[node];
      } else if (candidate == best[target]) {
        ways[target] += ways[node];
        if (ways[target] >= MOD)
          ways[target] -= MOD;
      }
      if (--indegree[target] == 0)
        queue[back++] = target;
    }
  }
  int64_t answer = -1;
  int count = 0;
  for (int node = 0; node < n; ++node) {
    if (outdegree[node] != 0)
      continue;
    if (best[node] > answer) {
      answer = best[node];
      count = ways[node];
    } else if (best[node] == answer) {
      count += ways[node];
      if (count >= MOD)
        count -= MOD;
    }
  }
  printf("%" PRId64 " %d\n", answer, count);
  free(next);
  free(to);
  free(queue);
  free(outdegree);
  free(indegree);
  free(head);
  free(ways);
  free(best);
  free(duration);
  return 0;
}
