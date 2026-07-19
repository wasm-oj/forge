#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
static void radix_sort(std::vector<std::string> &values) {
  std::vector<std::string> scratch(values.size());
  for (int pos = 29; pos >= 0; --pos) {
    std::array<std::size_t, 257> next{};
    for (const auto &value : values) {
      const unsigned key = static_cast<std::size_t>(pos) < value.size()
                               ? static_cast<unsigned char>(value[pos]) + 1U
                               : 0U;
      ++next[key];
    }
    std::size_t offset = 0;
    for (auto &entry : next) {
      const std::size_t count = entry;
      entry = offset;
      offset += count;
    }
    for (auto &value : values) {
      const unsigned key = static_cast<std::size_t>(pos) < value.size()
                               ? static_cast<unsigned char>(value[pos]) + 1U
                               : 0U;
      scratch[next[key]++] = std::move(value);
    }
    values.swap(scratch);
  }
}
int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  int Q;
  std::cin >> Q;
  while (Q--) {
    std::string k;
    int n, m;
    std::int64_t eps = 0;
    std::cin >> k >> n >> m;
    if (k == "FLOAT")
      std::cin >> eps;
    std::vector<std::string> a(n), b(m);
    for (auto &x : a)
      std::cin >> x;
    for (auto &x : b)
      std::cin >> x;
    bool ok;
    if (k == "EXACT") {
      std::string x, y;
      for (auto &s : a)
        x += s;
      for (auto &s : b)
        y += s;
      ok = x == y;
    } else if (k == "LINES") {
      while (!a.empty() && a.back() == "#")
        a.pop_back();
      while (!b.empty() && b.back() == "#")
        b.pop_back();
      ok = a == b;
    } else if (k == "TOKENS")
      ok = a == b;
    else if (k == "FLOAT") {
      ok = n == m;
      for (int i = 0; i < n && ok; i++) {
        auto x = std::stoll(a[i]), y = std::stoll(b[i]);
        std::uint64_t d = x >= y ? (std::uint64_t)x - (std::uint64_t)y
                                 : (std::uint64_t)y - (std::uint64_t)x;
        ok = d <= (std::uint64_t)eps;
      }
    } else {
      radix_sort(a);
      radix_sort(b);
      if (k == "SET") {
        a.erase(std::unique(a.begin(), a.end()), a.end());
        b.erase(std::unique(b.begin(), b.end()), b.end());
      }
      ok = a == b;
    }
    std::cout << (ok ? "ACCEPT\n" : "WRONG\n");
  }
}
