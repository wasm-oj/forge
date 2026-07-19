#include <algorithm>
#include <iostream>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int K, W, R, Q;
  if (!(cin >> K >> W >> R >> Q))
    return 0;
  vector<unsigned long long> w(K + 1, 1000);
  for (int i = 0, id; i < W; i++) {
    unsigned long long x;
    cin >> id >> x;
    w[id] = x;
  }
  vector<unsigned long long> pc(R + 1), pn(R + 1), rw(R), rc(R);
  for (int i = 0, id; i < R; i++) {
    cin >> id >> rc[i];
    rw[i] = w[id];
    pc[i + 1] = pc[i] + rw[i] * rc[i];
    pn[i + 1] = pn[i] + rc[i];
  }
  while (Q--) {
    unsigned long long b;
    cin >> b;
    int i = int(upper_bound(pc.begin(), pc.end(), b) - pc.begin()) - 1;
    auto cost = pc[i], done = pn[i];
    if (i < R) {
      auto take = min(rc[i], (b - cost) / rw[i]);
      done += take;
      cost += take * rw[i];
    }
    cout << done << ' ' << cost << '\n';
  }
}
