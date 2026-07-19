#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int f, n;
  uint64_t cap;
  if (!(cin >> f >> n >> cap))
    return 0;
  vector<uint64_t> sz(f + 1), cur(f + 1);
  uint64_t used = 0, peak = 0;
  while (n--) {
    string op;
    int x;
    uint64_t v;
    cin >> op >> x >> v;
    bool err = false;
    if (op == "SEEK")
      cur[x] = v;
    else {
      uint64_t ns = op == "WRITE" ? (v ? max(sz[x], cur[x] + v) : sz[x]) : v;
      if (ns > sz[x] && ns - sz[x] > cap - used)
        err = true;
      else {
        if (ns >= sz[x])
          used += ns - sz[x];
        else
          used -= sz[x] - ns;
        sz[x] = ns;
        if (op == "WRITE" && v)
          cur[x] += v;
      }
    }
    peak = max(peak, used);
    cout << (err ? "ERR QUOTA" : "OK") << ' ' << sz[x] << ' ' << cur[x] << ' '
         << used << '\n';
  }
  cout << "SUMMARY " << used << ' ' << peak << '\n';
}
