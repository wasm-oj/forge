#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  int first_child;
  int next_sibling;
  int exact_min;
  int file_min;
  int desc_min;
  unsigned char ch;
} Node;

static Node *nodes;
static int node_count;
static int node_capacity;
static int infinity;

static int new_node(unsigned char ch, int next_sibling) {
  if (node_count == node_capacity) {
    int next_capacity = node_capacity * 2;
    Node *grown = realloc(nodes, (size_t)next_capacity * sizeof(*nodes));
    if (grown == NULL)
      exit(1);
    nodes = grown;
    node_capacity = next_capacity;
  }
  int index = node_count++;
  nodes[index] = (Node){0, next_sibling, infinity, infinity, infinity, ch};
  return index;
}

static int find_or_create_child(int parent, unsigned char ch) {
  for (int child = nodes[parent].first_child; child != 0;
       child = nodes[child].next_sibling) {
    if (nodes[child].ch == ch)
      return child;
  }
  int child = new_node(ch, nodes[parent].first_child);
  nodes[parent].first_child = child;
  return child;
}

static unsigned char input_buffer[1 << 16];
static size_t input_at;
static size_t input_size;

static int next_byte(void) {
  if (input_at == input_size) {
    input_size = fread(input_buffer, 1, sizeof(input_buffer), stdin);
    input_at = 0;
    if (input_size == 0)
      return EOF;
  }
  return input_buffer[input_at++];
}

static int next_token(char *out, int capacity) {
  int c;
  do {
    c = next_byte();
  } while (c != EOF && c <= ' ');
  if (c == EOF)
    return 0;
  int length = 0;
  while (c != EOF && c > ' ') {
    if (length + 1 < capacity)
      out[length++] = (char)c;
    c = next_byte();
  }
  out[length] = '\0';
  return 1;
}

int main(void) {
  char token[32];
  if (!next_token(token, (int)sizeof(token)))
    return 0;
  int n = atoi(token);
  infinity = n + 1;
  node_capacity = 1024;
  nodes = calloc((size_t)node_capacity, sizeof(*nodes));
  if (nodes == NULL)
    return 1;
  node_count = 1;

  for (int j = 1; j <= n; ++j) {
    char kind[2];
    char path[201];
    next_token(kind, (int)sizeof(kind));
    next_token(path, (int)sizeof(path));
    size_t length = strlen(path);
    int visited[200];
    int current = 0;
    int best = infinity;

    for (size_t position = 0; position < length; ++position) {
      current = find_or_create_child(current, (unsigned char)path[position]);
      visited[position] = current;
      if (position + 1 < length &&
          (position == 0 || path[position + 1] == '/') &&
          nodes[current].file_min < best) {
        best = nodes[current].file_min;
      }
    }
    if (nodes[current].exact_min < best)
      best = nodes[current].exact_min;
    if (kind[0] == 'F' && nodes[current].desc_min < best)
      best = nodes[current].desc_min;

    if (best != infinity) {
      printf("CONFLICT %d %d\n", best, j);
      free(nodes);
      return 0;
    }

    for (size_t position = 0; position + 1 < length; ++position) {
      if ((position == 0 || path[position + 1] == '/') &&
          j < nodes[visited[position]].desc_min) {
        nodes[visited[position]].desc_min = j;
      }
    }
    if (j < nodes[current].exact_min)
      nodes[current].exact_min = j;
    if (kind[0] == 'F' && j < nodes[current].file_min)
      nodes[current].file_min = j;
  }

  puts("VALID");
  free(nodes);
  return 0;
}
