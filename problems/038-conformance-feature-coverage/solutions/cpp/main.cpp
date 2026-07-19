#include <algorithm>
#include <bit>
#include <cstdint>
#include <iostream>
#include <limits>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int F, N;
  uint64_t B;
  if (!(cin >> F >> N >> B))
    return 0;
  int S = 1 << F;
  const uint64_t INF = numeric_limits<uint64_t>::max() / 4;
  vector<uint64_t> dp(S, INF);
  dp[0] = 0;
  while (N--) {
    uint64_t cost;
    int k, m = 0, x;
    cin >> cost >> k;
    while (k--) {
      cin >> x;
      m |= 1 << (x - 1);
    }
    auto nx = dp;
    for (int s = 0; s < S; s++)
      if (dp[s] != INF)
        nx[s | m] = min(nx[s | m], dp[s] + cost);
    dp.swap(nx);
  }
  int ans = 0;
  for (int s = 0; s < S; s++)
    if (dp[s] <= B)
      ans = max(ans, popcount((unsigned)s));
  cout << ans << '\n';
}
