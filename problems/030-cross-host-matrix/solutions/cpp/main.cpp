#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
struct F {
  std::string p, v;
};
struct C {
  std::string id;
  std::uint64_t t;
  std::vector<F> f;
};
struct H {
  std::string name;
  std::vector<C> c;
};
int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  int n;
  std::cin >> n;
  std::vector<H> h(n);
  for (auto &z : h) {
    int k;
    std::cin >> z.name >> k;
    while (k--) {
      C c;
      int p;
      std::cin >> c.id >> c.t >> p;
      while (p--) {
        F f;
        std::cin >> f.p >> f.v;
        c.f.push_back(f);
      }
      z.c.push_back(c);
    }
  }
  bool all = true;
  for (int z = 1; z < n; z++) {
    bool order = h[z].c.size() != h[0].c.size();
    for (size_t i = 0; !order && i < h[0].c.size(); i++)
      order = h[z].c[i].id != h[0].c[i].id;
    if (order) {
      std::cout << "HOST " << h[z].name << " CASE_ORDER\n";
      all = false;
      continue;
    }
    std::vector<std::string> d;
    for (size_t i = 0; i < h[0].c.size(); i++) {
      auto &a = h[0].c[i];
      auto &b = h[z].c[i];
      size_t x = 0, y = 0;
      while (x < a.f.size() || y < b.f.size()) {
        if (y == b.f.size() || (x < a.f.size() && a.f[x].p < b.f[y].p))
          d.push_back(a.id + '.' + a.f[x++].p);
        else if (x == a.f.size() || a.f[x].p > b.f[y].p)
          d.push_back(a.id + '.' + b.f[y++].p);
        else {
          if (a.f[x].v != b.f[y].v)
            d.push_back(a.id + '.' + a.f[x].p);
          x++;
          y++;
        }
      }
    }
    std::cout << "HOST " << h[z].name;
    if (d.empty())
      std::cout << " OK\n";
    else {
      all = false;
      std::cout << ' ' << d.size();
      for (auto &x : d)
        std::cout << ' ' << x;
      std::cout << '\n';
    }
  }
  if (all)
    for (size_t i = 0; i < h[0].c.size(); i++) {
      std::vector<std::uint64_t> v;
      for (auto &z : h)
        v.push_back(z.c[i].t);
      std::sort(v.begin(), v.end());
      std::cout << "MEDIAN " << h[0].c[i].id << ' ' << v[(n - 1) / 2] << '\n';
    }
}
