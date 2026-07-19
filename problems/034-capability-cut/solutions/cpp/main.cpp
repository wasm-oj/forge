#include <algorithm>
#include <cstdint>
#include <functional>
#include <iostream>
#include <queue>
#include <vector>
using namespace std;
struct E {
  int to, rev;
  uint64_t cap;
};
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, m, sn, tn;
  if (!(cin >> n >> m >> sn >> tn))
    return 0;
  vector<uint64_t> c(n);
  uint64_t sum = 0;
  for (auto &x : c) {
    cin >> x;
    sum += x;
  }
  vector<int> en(sn), dn(tn);
  for (int &x : en) {
    cin >> x;
    --x;
  }
  for (int &x : dn) {
    cin >> x;
    --x;
  }
  int V = 2 * n + 2, S = 2 * n, T = S + 1;
  vector<vector<E>> g(V);
  auto add = [&](int u, int v, uint64_t z) {
    g[u].push_back({v, (int)g[v].size(), z});
    g[v].push_back({u, (int)g[u].size() - 1, 0});
  };
  uint64_t inf = sum + 1;
  for (int i = 0; i < n; i++)
    add(2 * i, 2 * i + 1, c[i]);
  while (m--) {
    int u, v;
    cin >> u >> v;
    add(2 * (u - 1) + 1, 2 * (v - 1), inf);
  }
  for (int x : en)
    add(S, 2 * x, inf);
  for (int x : dn)
    add(2 * x + 1, T, inf);
  uint64_t flow = 0;
  vector<int> level(V), it(V);
  for (;;) {
    fill(level.begin(), level.end(), -1);
    queue<int> q;
    q.push(S);
    level[S] = 0;
    while (!q.empty()) {
      int u = q.front();
      q.pop();
      for (auto &e : g[u])
        if (e.cap && level[e.to] < 0) {
          level[e.to] = level[u] + 1;
          q.push(e.to);
        }
    }
    if (level[T] < 0)
      break;
    fill(it.begin(), it.end(), 0);
    function<uint64_t(int, uint64_t)> dfs = [&](int u, uint64_t f) {
      if (u == T)
        return f;
      for (int &i = it[u]; i < (int)g[u].size(); i++) {
        E &e = g[u][i];
        if (e.cap && level[e.to] == level[u] + 1) {
          uint64_t z = dfs(e.to, min(f, e.cap));
          if (z) {
            e.cap -= z;
            g[e.to][e.rev].cap += z;
            return z;
          }
        }
      }
      return uint64_t(0);
    };
    for (uint64_t z; (z = dfs(S, inf));)
      flow += z;
  }
  cout << "COST " << flow << '\n';
}
