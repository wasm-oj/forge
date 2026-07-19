#include <algorithm>
#include <cstdint>
#include <iostream>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, B, I;
  if (!(cin >> n >> B >> I))
    return 0;
  vector<vector<uint64_t>> dp(I + 1, vector<uint64_t>(B + 1));
  while (n--) {
    int b, e;
    uint64_t v;
    cin >> b >> e >> v;
    for (int x = I; x >= e; x--)
      for (int y = B; y >= b; y--)
        dp[x][y] = max(dp[x][y], dp[x - e][y - b] + v);
  }
  cout << dp[I][B] << '\n';
}
