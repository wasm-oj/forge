#include <algorithm>
#include <climits>
#include <iostream>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int P, S, N, Q;
  if (!(cin >> P >> S >> N >> Q))
    return 0;
  vector<int> c(P + 1);
  vector<unsigned long long> lo(P + 1, ULLONG_MAX), hi(P + 1);
  for (int i = 0, p, s; i < N; i++) {
    unsigned long long x;
    cin >> p >> s >> x;
    c[p]++;
    lo[p] = min(lo[p], x);
    hi[p] = max(hi[p], x);
  }
  while (Q--) {
    int p;
    unsigned long long x;
    cin >> p >> x;
    if (c[p] != S || lo[p] != hi[p])
      cout << "INVALID\n";
    else
      cout << lo[p] << ' ' << (x > lo[p] ? x - lo[p] : 0) << '\n';
  }
}
