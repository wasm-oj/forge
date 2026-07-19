#include <algorithm>
#include <iostream>
#include <string>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, q;
  if (!(cin >> n >> q))
    return 0;
  vector<pair<string, string>> f(n);
  for (auto &x : f)
    cin >> x.first >> x.second;
  while (q--) {
    string a, b, c, d;
    int k;
    cin >> a >> b >> c >> d >> k;
    vector<int> v(k);
    for (int &x : v) {
      cin >> x;
      --x;
    }
    sort(v.begin(), v.end(),
         [&](int x, int y) { return f[x].first < f[y].first; });
    cout << a << ' ' << b << ' ' << c << ' ' << d << ' ' << k;
    for (int x : v)
      cout << ' ' << f[x].first << ' ' << f[x].second;
    cout << '\n';
  }
}
