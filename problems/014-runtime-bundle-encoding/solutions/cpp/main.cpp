#include <algorithm>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>
using namespace std;
struct R {
  char t;
  string p, v;
};
void bytes(const string &s) {
  for (unsigned char c : s)
    cout << setw(2) << (unsigned)c;
}
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n;
  if (!(cin >> n))
    return 0;
  vector<R> a(n);
  for (auto &x : a)
    cin >> x.t >> x.p >> x.v;
  sort(a.begin(), a.end(), [](auto &x, auto &y) { return x.p < y.p; });
  cout << hex << nouppercase << setfill('0') << "574f424a" << setw(8)
       << (unsigned)n;
  for (auto &x : a) {
    size_t z = x.v == "-" ? 0 : (x.t == 'T' ? x.v.size() : x.v.size() / 2);
    cout << (x.t == 'T' ? "01" : "02") << setw(8) << (unsigned)x.p.size();
    bytes(x.p);
    cout << setw(16) << (unsigned long long)z;
    if (z) {
      if (x.t == 'T')
        bytes(x.v);
      else
        cout << x.v;
    }
  }
  cout << '\n';
}
