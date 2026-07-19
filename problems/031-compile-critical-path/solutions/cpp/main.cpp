#include <cstdint>
#include <deque>
#include <iostream>
#include <vector>

using namespace std;

int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  constexpr int MOD = 1'000'000'007;
  int n, m;
  cin >> n >> m;
  vector<int64_t> duration(n);
  for (auto &value : duration)
    cin >> value;
  vector<vector<int>> graph(n);
  vector<int> indegree(n), outdegree(n);
  for (int i = 0; i < m; ++i) {
    int u, v;
    cin >> u >> v;
    --u;
    --v;
    graph[u].push_back(v);
    ++indegree[v];
    ++outdegree[u];
  }
  vector<int64_t> best(n);
  vector<int> ways(n);
  deque<int> queue;
  for (int node = 0; node < n; ++node) {
    if (indegree[node] == 0) {
      best[node] = duration[node];
      ways[node] = 1;
      queue.push_back(node);
    }
  }
  while (!queue.empty()) {
    const int node = queue.front();
    queue.pop_front();
    for (const int target : graph[node]) {
      const int64_t candidate = best[node] + duration[target];
      if (candidate > best[target]) {
        best[target] = candidate;
        ways[target] = ways[node];
      } else if (candidate == best[target]) {
        ways[target] += ways[node];
        if (ways[target] >= MOD)
          ways[target] -= MOD;
      }
      if (--indegree[target] == 0)
        queue.push_back(target);
    }
  }
  int64_t answer = -1;
  int count = 0;
  for (int node = 0; node < n; ++node) {
    if (outdegree[node] != 0)
      continue;
    if (best[node] > answer) {
      answer = best[node];
      count = ways[node];
    } else if (best[node] == answer) {
      count += ways[node];
      if (count >= MOD)
        count -= MOD;
    }
  }
  cout << answer << ' ' << count << '\n';
}
