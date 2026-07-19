#include <algorithm>
#include <cstdint>
#include <functional>
#include <iostream>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, C;
  if (!(cin >> n >> C))
    return 0;
  vector<vector<int>> ch(n + 1);
  vector<int> sz(n + 1);
  vector<uint64_t> val(n + 1);
  for (int i = 1, p; i <= n; i++) {
    cin >> p >> sz[i] >> val[i];
    ch[p].push_back(i);
  }
  vector<int> order, after;
  function<void(int)> dfs = [&](int u) {
    int pos = order.size();
    order.push_back(u);
    after.push_back(0);
    for (int v : ch[u])
      dfs(v);
    after[pos] = order.size();
  };
  for (int u : ch[0])
    dfs(u);
  vector<vector<uint64_t>> dp(n + 1, vector<uint64_t>(C + 1));
  for (int i = n - 1; i >= 0; i--) {
    int u = order[i];
    for (int c = 0; c <= C; c++) {
      dp[i][c] = dp[after[i]][c];
      if (c >= sz[u])
        dp[i][c] = max(dp[i][c], val[u] + dp[i + 1][c - sz[u]]);
    }
  }
  cout << dp[0][C] << '\n';
}
