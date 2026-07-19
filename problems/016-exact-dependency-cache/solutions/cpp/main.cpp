#include <cstdint>
#include <iostream>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, h, m, q;
  if (!(cin >> n >> h >> m >> q))
    return 0;
  int w = (n + 63) / 64;
  vector<vector<uint64_t>> b(h, vector<uint64_t>(w));
  while (m--) {
    int s, x;
    cin >> s >> x;
    b[x - 1][(s - 1) / 64] |= uint64_t(1) << ((s - 1) % 64);
  }
  while (q--) {
    vector<uint64_t> v(w);
    int k;
    cin >> k;
    while (k--) {
      int x;
      cin >> x;
      for (int j = 0; j < w; j++)
        v[j] |= b[x - 1][j];
    }
    int ans = 0;
    for (auto x : v)
      ans += __builtin_popcountll(x);
    cout << ans << '\n';
  }
}
