#include <algorithm>
#include <cstdint>
#include <iostream>
#include <utility>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int G, C;
  if (!(cin >> G >> C))
    return 0;
  vector<uint64_t> dp(C + 1);
  while (G--) {
    int k;
    cin >> k;
    vector<pair<int, uint64_t>> a(k);
    for (auto &[w, v] : a)
      cin >> w >> v;
    auto next = dp;
    for (auto [w, v] : a)
      for (int c = w; c <= C; c++)
        next[c] = max(next[c], dp[c - w] + v);
    dp.swap(next);
  }
  cout << dp[C] << '\n';
}
