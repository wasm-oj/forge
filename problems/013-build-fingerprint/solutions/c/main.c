#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  char *path;
  char *digest;
} File;

static File *files;

static char *read_token(void) {
  int ch;
  do {
    ch = getchar();
  } while (ch != EOF && isspace((unsigned char)ch));
  if (ch == EOF)
    return NULL;

  size_t length = 0;
  size_t capacity = 32;
  char *token = malloc(capacity);
  if (token == NULL)
    return NULL;
  while (ch != EOF && !isspace((unsigned char)ch)) {
    if (length + 1 == capacity) {
      capacity *= 2;
      char *grown = realloc(token, capacity);
      if (grown == NULL) {
        free(token);
        return NULL;
      }
      token = grown;
    }
    token[length++] = (char)ch;
    ch = getchar();
  }
  token[length] = '\0';
  return token;
}

static int read_int(void) {
  char *token = read_token();
  if (token == NULL)
    exit(1);
  int value = (int)strtol(token, NULL, 10);
  free(token);
  return value;
}

static int compare_file_ids(const void *left, const void *right) {
  int left_id = *(const int *)left;
  int right_id = *(const int *)right;
  return strcmp(files[left_id].path, files[right_id].path);
}

int main(void) {
  int file_count = read_int();
  int build_count = read_int();
  files = malloc((size_t)file_count * sizeof(*files));
  if (files == NULL)
    return 1;

  for (int i = 0; i < file_count; i++) {
    files[i].path = read_token();
    files[i].digest = read_token();
    if (files[i].path == NULL || files[i].digest == NULL)
      return 1;
  }

  for (int build = 0; build < build_count; build++) {
    char *compiler = read_token();
    char *target = read_token();
    char *optimization = read_token();
    char *dependency_digest = read_token();
    int selected_count = read_int();
    if (compiler == NULL || target == NULL || optimization == NULL ||
        dependency_digest == NULL)
      return 1;

    int *ids = malloc((size_t)(selected_count > 0 ? selected_count : 1) *
                      sizeof(*ids));
    if (ids == NULL)
      return 1;
    for (int i = 0; i < selected_count; i++)
      ids[i] = read_int() - 1;
    qsort(ids, (size_t)selected_count, sizeof(*ids), compare_file_ids);

    printf("%s %s %s %s %d", compiler, target, optimization, dependency_digest,
           selected_count);
    for (int i = 0; i < selected_count; i++)
      printf(" %s %s", files[ids[i]].path, files[ids[i]].digest);
    putchar('\n');

    free(ids);
    free(compiler);
    free(target);
    free(optimization);
    free(dependency_digest);
  }

  for (int i = 0; i < file_count; i++) {
    free(files[i].path);
    free(files[i].digest);
  }
  free(files);
  return 0;
}
