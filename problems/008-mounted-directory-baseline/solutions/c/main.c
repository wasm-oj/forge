#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  uint32_t offset;
  uint32_t length;
} Path;

static const uint32_t *segments;

static int compare_paths(const void *left_ptr, const void *right_ptr) {
  const Path *left = left_ptr;
  const Path *right = right_ptr;
  uint32_t common = left->length < right->length ? left->length : right->length;

  for (uint32_t i = 0; i < common; ++i) {
    uint32_t a = segments[left->offset + i];
    uint32_t b = segments[right->offset + i];
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
  }
  return (left->length > right->length) - (left->length < right->length);
}

static uint32_t common_prefix(const Path *left, const Path *right) {
  uint32_t common = left->length < right->length ? left->length : right->length;
  uint32_t i = 0;
  while (i < common &&
         segments[left->offset + i] == segments[right->offset + i]) {
    ++i;
  }
  return i;
}

int main(void) {
  int mounted_count;
  int output_count;
  uint64_t byte_quota;
  uint64_t inode_quota;
  if (scanf("%d%d%" SCNu64 "%" SCNu64, &mounted_count, &output_count,
            &byte_quota, &inode_quota) != 4) {
    return 0;
  }

  int path_count = mounted_count + output_count;
  Path *paths = malloc((size_t)path_count * sizeof(*paths));
  uint32_t *all_segments = malloc(200000U * sizeof(*all_segments));
  if (paths == NULL || all_segments == NULL) {
    free(paths);
    free(all_segments);
    return 1;
  }
  segments = all_segments;

  uint32_t segment_count = 0;
  uint64_t baseline_bytes = 0;
  for (int i = 0; i < path_count; ++i) {
    int length;
    if (scanf("%d", &length) != 1) {
      free(paths);
      free(all_segments);
      return 1;
    }
    paths[i].offset = segment_count;
    paths[i].length = (uint32_t)length;
    for (int j = 0; j < length; ++j) {
      if (scanf("%u", &all_segments[segment_count++]) != 1) {
        free(paths);
        free(all_segments);
        return 1;
      }
    }
    if (i < mounted_count) {
      unsigned long long size;
      if (scanf("%llu", &size) != 1) {
        free(paths);
        free(all_segments);
        return 1;
      }
      baseline_bytes += (uint64_t)size;
    }
  }

  qsort(paths, (size_t)path_count, sizeof(*paths), compare_paths);

  uint64_t directory_count = 1;
  for (int i = 0; i < path_count; ++i) {
    uint32_t parent_length = paths[i].length - 1U;
    uint32_t already_present = 0;
    if (i > 0) {
      already_present = common_prefix(&paths[i - 1], &paths[i]);
      if (already_present > parent_length) {
        already_present = parent_length;
      }
    }
    directory_count += parent_length - already_present;
  }

  uint64_t baseline_inodes = directory_count + (uint64_t)path_count;
  if (baseline_bytes <= byte_quota && baseline_inodes <= inode_quota) {
    printf("ACCEPT %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
           baseline_bytes, baseline_inodes, byte_quota - baseline_bytes,
           inode_quota - baseline_inodes);
  } else {
    printf("REJECT %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
           baseline_bytes, baseline_inodes,
           baseline_bytes > byte_quota ? baseline_bytes - byte_quota : 0,
           baseline_inodes > inode_quota ? baseline_inodes - inode_quota : 0);
  }

  free(paths);
  free(all_segments);
  return 0;
}
