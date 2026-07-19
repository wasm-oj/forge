#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
using namespace std;
struct File {
  string p;
  uint64_t m, a;
};
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, q;
  uint64_t u;
  if (!(cin >> n >> q >> u))
    return 0;
  vector<File> f(n);
  for (auto &x : f)
    cin >> x.p >> x.m >> x.a;
  sort(f.begin(), f.end(),
       [](const File &a, const File &b) { return a.p < b.p; });
  vector<uint64_t> pre(n + 1);
  int mismatch = n;
  for (int i = 0; i < n; i++) {
    pre[i + 1] = pre[i] + f[i].m;
    if (mismatch == n && f[i].m != f[i].a)
      mismatch = i;
  }
  int k = 0;
  while (q--) {
    uint64_t b;
    cin >> b;
    if (b < u) {
      cout << "ERR QUOTA -\n";
      continue;
    }
    uint64_t cap = b - u;
    while (k < n && pre[k + 1] <= cap)
      k++;
    if (k < mismatch)
      cout << "ERR QUOTA " << f[k].p << '\n';
    else if (mismatch < n)
      cout << "ERR MISMATCH " << f[mismatch].p << '\n';
    else if (k < n)
      cout << "ERR QUOTA " << f[k].p << '\n';
    else
      cout << "OK " << n << ' ' << u + pre[n] << '\n';
  }
}
