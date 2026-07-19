#include <algorithm>
#include <cstdint>
#include <iostream>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, c;
  if (!(cin >> n >> c))
    return 0;
  vector<uint64_t> dp(c + 1);
  while (n--) {
    int w;
    uint64_t v;
    cin >> w >> v;
    for (int x = c; x >= w; x--)
      dp[x] = max(dp[x], dp[x - w] + v);
  }
  cout << dp[c] << '\n';
}
