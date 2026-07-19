#include <algorithm>
#include <cstdint>
#include <iostream>
#include <numeric>
#include <vector>
using namespace std;
struct E {
  int u, v;
  uint64_t w;
};
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, m;
  if (!(cin >> n >> m))
    return 0;
  vector<E> e(m);
  for (auto &x : e) {
    cin >> x.u >> x.v >> x.w;
    --x.u;
    --x.v;
  }
  sort(e.begin(), e.end(), [](auto &a, auto &b) { return a.w < b.w; });
  vector<int> p(n), sz(n, 1);
  iota(p.begin(), p.end(), 0);
  auto find = [&](int x) {
    int r = x;
    while (p[r] != r)
      r = p[r];
    while (p[x] != x) {
      int y = p[x];
      p[x] = r;
      x = y;
    }
    return r;
  };
  uint64_t cost = 0;
  int take = 0;
  for (auto &x : e) {
    int u = find(x.u), v = find(x.v);
    if (u == v)
      continue;
    if (sz[u] < sz[v])
      swap(u, v);
    p[v] = u;
    sz[u] += sz[v];
    cost += x.w;
    if (++take == n - 1)
      break;
  }
  if (take == n - 1)
    cout << "COST " << cost << '\n';
  else
    cout << "IMPOSSIBLE\n";
}
