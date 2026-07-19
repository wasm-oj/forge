#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <vector>
std::int64_t rmq(const std::vector<std::int64_t> &t, int b, int l, int r) {
  std::int64_t z = 0;
  for (l = b + l - 1, r = b + r - 1; l <= r; l /= 2, r /= 2) {
    if (l & 1)
      z = std::max(z, t[l++]);
    if (!(r & 1))
      z = std::max(z, t[r--]);
  }
  return z;
}
int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  int n, q;
  std::cin >> n >> q;
  std::vector<int> bad(n + 2), nb(n + 2);
  std::array<std::vector<int>, 4> u;
  std::array<std::vector<std::int64_t>, 2> s;
  for (auto &x : u)
    x.assign(n + 1, 0);
  for (auto &x : s)
    x.assign(n + 1, 0);
  int b = 1;
  while (b < n)
    b *= 2;
  std::vector<std::int64_t> tm(2 * b), tv(2 * b);
  for (int i = 1; i <= n; i++) {
    std::array<std::int64_t, 4> x;
    std::cin >> bad[i] >> x[0] >> x[1] >> x[2] >> x[3];
    for (int j = 0; j < 4; j++)
      u[j][i] = u[j][i - 1] + (x[j] < 0);
    for (int j = 0; j < 2; j++)
      s[j][i] = s[j][i - 1] + std::max<std::int64_t>(0, x[j]);
    tm[b + i - 1] = std::max<std::int64_t>(0, x[2]);
    tv[b + i - 1] = std::max<std::int64_t>(0, x[3]);
  }
  for (int i = b - 1; i; i--) {
    tm[i] = std::max(tm[2 * i], tm[2 * i + 1]);
    tv[i] = std::max(tv[2 * i], tv[2 * i + 1]);
  }
  nb[n + 1] = n + 1;
  for (int i = n; i; i--)
    nb[i] = bad[i] ? i : nb[i + 1];
  while (q--) {
    int l, r, f;
    std::cin >> l >> r >> f;
    int e = f && nb[l] <= r ? nb[l] : r;
    std::cout << e - l + 1 << ' ' << (nb[l] <= e ? bad[nb[l]] : 0);
    for (int j = 0; j < 2; j++)
      if (u[j][e] > u[j][l - 1])
        std::cout << " null";
      else
        std::cout << ' ' << s[j][e] - s[j][l - 1];
    for (int j = 2; j < 4; j++)
      if (u[j][e] > u[j][l - 1])
        std::cout << " null";
      else
        std::cout << ' ' << rmq(j == 2 ? tm : tv, b, l, e);
    std::cout << '\n';
  }
}
