#include <iostream>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, m;
  if (!(cin >> n >> m))
    return 0;
  vector<vector<int>> g(n), rg(n);
  vector<pair<int, int>> edges;
  vector<char> self(n);
  while (m--) {
    int u, v;
    cin >> u >> v;
    --u;
    --v;
    g[u].push_back(v);
    rg[v].push_back(u);
    edges.push_back({u, v});
    if (u == v)
      self[u] = 1;
  }
  vector<char> seen(n);
  vector<int> cur(n), order;
  for (int s = 0; s < n; s++) {
    if (seen[s])
      continue;
    vector<int> st{s};
    seen[s] = 1;
    while (!st.empty()) {
      int u = st.back();
      if (cur[u] < (int)g[u].size()) {
        int v = g[u][cur[u]++];
        if (!seen[v])
          seen[v] = 1, st.push_back(v);
      } else {
        order.push_back(u);
        st.pop_back();
      }
    }
  }
  vector<int> comp(n, -1);
  int cc = 0;
  for (auto it = order.rbegin(); it != order.rend(); ++it) {
    int s = *it;
    if (comp[s] >= 0)
      continue;
    vector<int> st{s};
    comp[s] = cc;
    while (!st.empty()) {
      int u = st.back();
      st.pop_back();
      for (int v : rg[u])
        if (comp[v] < 0)
          comp[v] = cc, st.push_back(v);
    }
    cc++;
  }
  vector<vector<int>> mem(cc);
  for (int i = 0; i < n; i++)
    mem[comp[i]].push_back(i);
  vector<char> indeg(cc);
  for (auto [u, v] : edges)
    if (comp[u] != comp[v])
      indeg[comp[v]] = 1;
  int groups = 0, wake = 0;
  for (int c = 0; c < cc; c++) {
    wake += !indeg[c];
    groups += mem[c].size() > 1 || self[mem[c][0]];
  }
  cout << groups << ' ' << wake << '\n';
  for (int i = 0; i < n; i++) {
    int c = comp[i];
    if (mem[c][0] != i || !(mem[c].size() > 1 || self[i]))
      continue;
    cout << mem[c].size();
    for (int v : mem[c])
      cout << ' ' << v + 1;
    cout << '\n';
  }
}
