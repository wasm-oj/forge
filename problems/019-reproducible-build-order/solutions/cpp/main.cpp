#include <algorithm>
#include <iostream>
#include <numeric>
#include <queue>
#include <string>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, m;
  if (!(cin >> n >> m))
    return 0;
  vector<string> names(n);
  for (int i = 0; i < n; i++)
    cin >> names[i];
  vector<int> name_order(n);
  iota(name_order.begin(), name_order.end(), 0);
  sort(name_order.begin(), name_order.end(),
       [&](int x, int y) { return names[x] < names[y]; });
  auto find_id = [&](const string &name) {
    auto it =
        lower_bound(name_order.begin(), name_order.end(), name,
                    [&](int id, const string &key) { return names[id] < key; });
    return it != name_order.end() && names[*it] == name ? *it : -1;
  };
  vector<vector<int>> g(n);
  vector<int> deg(n);
  int bad = 0;
  for (int i = 1; i <= m; i++) {
    string a, b;
    cin >> a >> b;
    int x = find_id(a), y = find_id(b);
    if (x < 0 || y < 0) {
      if (!bad)
        bad = i;
    } else {
      g[y].push_back(x);
      deg[x]++;
    }
  }
  if (bad) {
    cout << "INVALID DANGLING " << bad << '\n';
    return 0;
  }
  auto name_greater = [&](int x, int y) { return names[x] > names[y]; };
  priority_queue<int, vector<int>, decltype(name_greater)> q(name_greater);
  for (int i = 0; i < n; i++)
    if (!deg[i])
      q.push(i);
  vector<int> out;
  while (!q.empty()) {
    int u = q.top();
    q.pop();
    out.push_back(u);
    for (int v : g[u])
      if (!--deg[v])
        q.push(v);
  }
  if ((int)out.size() < n)
    cout << "INVALID CYCLE\n";
  else {
    cout << "ORDER";
    for (int id : out)
      cout << ' ' << names[id];
    cout << '\n';
  }
}
