#include <algorithm>
#include <cstdint>
#include <iostream>
#include <vector>

int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);

  int mounted_count;
  int output_count;
  std::uint64_t byte_quota;
  std::uint64_t inode_quota;
  if (!(std::cin >> mounted_count >> output_count >> byte_quota >>
        inode_quota)) {
    return 0;
  }

  const int path_count = mounted_count + output_count;
  std::vector<std::vector<std::uint32_t>> paths(path_count);
  std::uint64_t baseline_bytes = 0;
  for (int i = 0; i < path_count; ++i) {
    int length;
    std::cin >> length;
    paths[i].resize(static_cast<std::size_t>(length));
    for (std::uint32_t &segment : paths[i]) {
      std::cin >> segment;
    }
    if (i < mounted_count) {
      std::uint64_t size;
      std::cin >> size;
      baseline_bytes += size;
    }
  }

  std::sort(paths.begin(), paths.end());

  std::uint64_t directory_count = 1;
  for (int i = 0; i < path_count; ++i) {
    const std::size_t parent_length = paths[i].size() - 1;
    std::size_t already_present = 0;
    if (i > 0) {
      const std::size_t common_limit =
          std::min(paths[i - 1].size(), paths[i].size());
      while (already_present < common_limit &&
             paths[i - 1][already_present] == paths[i][already_present]) {
        ++already_present;
      }
      already_present = std::min(already_present, parent_length);
    }
    directory_count += parent_length - already_present;
  }

  const std::uint64_t baseline_inodes =
      directory_count + static_cast<std::uint64_t>(path_count);
  if (baseline_bytes <= byte_quota && baseline_inodes <= inode_quota) {
    std::cout << "ACCEPT " << baseline_bytes << ' ' << baseline_inodes << ' '
              << byte_quota - baseline_bytes << ' '
              << inode_quota - baseline_inodes << '\n';
  } else {
    std::cout << "REJECT " << baseline_bytes << ' ' << baseline_inodes << ' '
              << (baseline_bytes > byte_quota ? baseline_bytes - byte_quota : 0)
              << ' '
              << (baseline_inodes > inode_quota ? baseline_inodes - inode_quota
                                                : 0)
              << '\n';
  }
}
