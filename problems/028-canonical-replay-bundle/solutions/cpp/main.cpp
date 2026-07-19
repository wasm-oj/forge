#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
struct B {
  std::string d;
  std::int64_t x, y;
};
int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  int n, r;
  std::cin >> n >> r;
  std::vector<B> a(n);
  std::vector<std::string> q(r);
  for (auto &z : a)
    std::cin >> z.d >> z.x >> z.y;
  for (auto &z : q)
    std::cin >> z;
  for (int i = 1; i < n; i++)
    if (a[i].d <= a[i - 1].d) {
      std::cout << "INVALID BLOB_ORDER " << i + 1 << '\n';
      return 0;
    }
  for (int i = 0; i < n; i++)
    if (a[i].x != a[i].y) {
      std::cout << "INVALID LENGTH " << i + 1 << '\n';
      return 0;
    }
  for (int i = 1; i < r; i++)
    if (q[i] <= q[i - 1]) {
      std::cout << "INVALID REF_ORDER " << i + 1 << '\n';
      return 0;
    }
  int j = 0;
  for (int i = 0; i < r; i++) {
    while (j < n && a[j].d < q[i])
      j++;
    if (j == n || a[j].d != q[i]) {
      std::cout << "INVALID MISSING " << i + 1 << '\n';
      return 0;
    }
    j++;
  }
  j = 0;
  std::int64_t total = 0;
  for (int i = 0; i < r; i++) {
    while (a[j].d < q[i])
      j++;
    total += a[j++].y;
  }
  std::cout << "VALID " << total << '\n';
}
