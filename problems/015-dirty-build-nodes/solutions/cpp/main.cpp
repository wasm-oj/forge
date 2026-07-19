#include <deque>
#include <iostream>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, m, c;
  if (!(cin >> n >> m >> c))
    return 0;
  vector<vector<int>> g(n);
  while (m--) {
    int u, v;
    cin >> u >> v;
    g[u - 1].push_back(v - 1);
  }
  vector<char> d(n);
  deque<int> q;
  while (c--) {
    int x;
    cin >> x;
    if (!d[--x])
      d[x] = 1, q.push_back(x);
  }
  while (!q.empty()) {
    int u = q.front();
    q.pop_front();
    for (int v : g[u])
      if (!d[v])
        d[v] = 1, q.push_back(v);
  }
  int k = 0;
  for (char x : d)
    k += x;
  cout << k << '\n';
  bool first = true;
  for (int i = 0; i < n; i++)
    if (d[i]) {
      if (!first)
        cout << ' ';
      cout << i + 1;
      first = false;
    }
  cout << '\n';
}
