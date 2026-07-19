#include <algorithm>
#include <iostream>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, q;
  unsigned long long c;
  if (!(cin >> n >> q >> c))
    return 0;
  vector<unsigned long long> pi(n + 1), pm(n + 1);
  vector<int> bad(n + 2), nxt(n + 2);
  for (int i = 1, k; i <= n; i++) {
    unsigned long long x;
    long long m;
    cin >> k >> x >> m;
    bad[i] = k == 64 || x > c || (m >= 0 && (unsigned long long)m < x);
    pi[i] = pi[i - 1];
    pm[i] = pm[i - 1];
    if (!bad[i]) {
      pi[i] += x;
      pm[i] += m < 0 ? c : min(c, (unsigned long long)m);
    }
  }
  nxt[n + 1] = n + 1;
  for (int i = n; i; i--)
    nxt[i] = bad[i] ? i : nxt[i + 1];
  while (q--) {
    int l, r;
    cin >> l >> r;
    if (nxt[l] <= r)
      cout << "REJECT " << nxt[l] << '\n';
    else
      cout << "ACCEPT " << (pi[r] - pi[l - 1]) * 65536ULL << ' '
           << (pm[r] - pm[l - 1]) * 65536ULL << '\n';
  }
}
