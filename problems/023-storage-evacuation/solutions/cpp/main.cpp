#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
struct I {
  std::int64_t z, u;
  int p;
  std::string a, k;
};
int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  int n;
  std::int64_t C, A, R, T = 0;
  std::cin >> n >> C >> A >> R;
  std::vector<I> x(n);
  for (auto &v : x) {
    std::cin >> v.z >> v.p >> v.u >> v.a >> v.k;
    T += v.z;
  }
  auto need = std::max<std::int64_t>({0, T - C, R - A});
  if (need > T) {
    std::cout << "IMPOSSIBLE\n";
    return 0;
  }
  std::sort(x.begin(), x.end(), [](const I &a, const I &b) {
    if (a.p != b.p)
      return a.p < b.p;
    if (a.u != b.u)
      return a.u < b.u;
    if (a.a != b.a)
      return a.a < b.a;
    return a.k < b.k;
  });
  std::int64_t f = 0;
  int k = 0;
  while (f < need)
    f += x[k++].z;
  std::cout << k << ' ' << f << '\n';
  for (int i = 0; i < k; i++)
    std::cout << x[i].a << ' ' << x[i].k << '\n';
}
