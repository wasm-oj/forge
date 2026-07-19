#include <cstdint>
#include <iostream>
#include <vector>
struct A {
  char t;
  std::int64_t k;
};
int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  std::int64_t C;
  int n[2];
  std::cin >> C >> n[0] >> n[1];
  std::vector<A> a[2];
  for (int w = 0; w < 2; w++)
    for (int i = 0; i < n[w]; i++) {
      A x;
      std::cin >> x.t;
      x.k = 0;
      if (x.t != 'C')
        std::cin >> x.k;
      a[w].push_back(x);
    }
  int pc[2] = {}, closed[2] = {n[0] == 0, n[1] == 0};
  std::int64_t occ[2] = {}, steps = 0;
  auto one = [&](int w) {
    if (pc[w] == n[w])
      return 2;
    A x = a[w][pc[w]];
    int o = 1 - w;
    if (x.t == 'W') {
      if (C - occ[w] < x.k)
        return 0;
      occ[w] += x.k;
    } else if (x.t == 'R') {
      if (occ[o] < x.k)
        return closed[o] ? -1 : 0;
      occ[o] -= x.k;
    } else
      closed[w] = 1;
    pc[w]++;
    steps++;
    if (pc[w] == n[w])
      closed[w] = 1;
    return 1;
  };
  for (;;) {
    if (pc[0] == n[0] && pc[1] == n[1]) {
      std::cout << "SUCCESS " << steps << ' ' << occ[0] << ' ' << occ[1]
                << '\n';
      break;
    }
    bool progress = false;
    for (int w = 0; w < 2; w++) {
      int z = one(w);
      if (z < 0) {
        std::cout << "FAIL " << (w ? 'B' : 'A') << ' ' << steps << ' ' << occ[0]
                  << ' ' << occ[1] << '\n';
        return 0;
      }
      progress |= z == 1;
    }
    if (!progress) {
      std::cout << "DEADLOCK " << steps << ' ' << occ[0] << ' ' << occ[1]
                << '\n';
      break;
    }
  }
}
