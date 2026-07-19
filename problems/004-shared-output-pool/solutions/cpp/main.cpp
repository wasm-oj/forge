#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, q;
  if (!(cin >> n >> q))
    return 0;
  vector<char> s(n);
  vector<uint64_t> a(n);
  for (int i = 0; i < n; i++)
    cin >> s[i] >> a[i];
  int i = 0;
  uint64_t used = 0;
  array<uint64_t, 3> c{};
  while (q--) {
    uint64_t b;
    cin >> b;
    while (i < n && a[i] <= b - used) {
      used += a[i];
      int k = s[i] == 'O' ? 0 : s[i] == 'E' ? 1 : 2;
      c[k] += a[i++];
    }
    auto d = c;
    int fail = 0;
    if (i < n) {
      fail = i + 1;
      int k = s[i] == 'O' ? 0 : s[i] == 'E' ? 1 : 2;
      d[k] += b - used;
    }
    cout << fail << ' ' << d[0] << ' ' << d[1] << ' ' << d[2] << '\n';
  }
}
