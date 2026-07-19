#include <iostream>
#include <queue>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int L, R, M;
  if (!(cin >> L >> R >> M))
    return 0;
  vector<vector<int>> g(L);
  while (M--) {
    int u, v;
    cin >> u >> v;
    g[u - 1].push_back(v - 1);
  }
  vector<int> pu(L, -1), pv(R, -1), dist(L), cur(L);
  int matching = 0;
  for (;;) {
    queue<int> q;
    for (int u = 0; u < L; u++) {
      dist[u] = pu[u] < 0 ? 0 : -1;
      if (pu[u] < 0)
        q.push(u);
    }
    int terminal = -1;
    while (!q.empty()) {
      int u = q.front();
      q.pop();
      if (terminal >= 0 && dist[u] >= terminal)
        continue;
      for (int v : g[u]) {
        int w = pv[v];
        if (w < 0)
          terminal = dist[u];
        else if (dist[w] < 0) {
          dist[w] = dist[u] + 1;
          q.push(w);
        }
      }
    }
    if (terminal < 0)
      break;
    fill(cur.begin(), cur.end(), 0);
    for (int root = 0; root < L; root++) {
      if (pu[root] >= 0)
        continue;
      vector<int> su{root}, sv;
      bool ok = false;
      while (!su.empty() && !ok) {
        int u = su.back();
        bool down = false;
        while (cur[u] < (int)g[u].size()) {
          int v = g[u][cur[u]++], w = pv[v];
          if (w < 0 && dist[u] == terminal) {
            pu[u] = v;
            pv[v] = u;
            for (int i = (int)sv.size() - 1; i >= 0; i--) {
              pu[su[i]] = sv[i];
              pv[sv[i]] = su[i];
            }
            ok = true;
            break;
          }
          if (w >= 0 && dist[u] < terminal && dist[w] == dist[u] + 1) {
            sv.push_back(v);
            su.push_back(w);
            down = true;
            break;
          }
        }
        if (!ok && !down) {
          dist[u] = -1;
          su.pop_back();
          if (!sv.empty())
            sv.pop_back();
        }
      }
      if (ok)
        matching++;
    }
  }
  cout << matching << '\n';
}
