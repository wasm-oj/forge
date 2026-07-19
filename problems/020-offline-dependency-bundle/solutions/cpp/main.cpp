#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
using namespace std;
struct R {
  string d;
  uint64_t z;
};
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, m;
  if (!(cin >> n >> m))
    return 0;
  vector<R> l(n), p(m), req;
  uint64_t total = 0;
  for (auto &x : l) {
    string name;
    cin >> name >> x.d >> x.z;
    total += x.z;
  }
  for (auto &x : p)
    cin >> x.d >> x.z;
  auto less = [](const R &a, const R &b) { return a.d < b.d; };
  sort(l.begin(), l.end(), less);
  sort(p.begin(), p.end(), less);
  for (int i = 0; i < n;) {
    int j = i + 1;
    while (j < n && l[j].d == l[i].d) {
      if (l[j].z != l[i].z) {
        cout << "LOCK_CONFLICT " << l[i].d << '\n';
        return 0;
      }
      j++;
    }
    req.push_back(l[i]);
    i = j;
  }
  for (int i = 1; i < m; i++)
    if (p[i].d == p[i - 1].d) {
      cout << "DUPLICATE_PAYLOAD " << p[i].d << '\n';
      return 0;
    }
  auto has = [](const vector<R> &a, const string &d) {
    return lower_bound(a.begin(), a.end(), R{d, 0},
                       [](auto &x, auto &y) { return x.d < y.d; });
  };
  for (auto &x : req)
    if (has(p, x.d) == p.end() || has(p, x.d)->d != x.d) {
      cout << "MISSING " << x.d << '\n';
      return 0;
    }
  for (auto &x : p)
    if (has(req, x.d) == req.end() || has(req, x.d)->d != x.d) {
      cout << "EXTRA " << x.d << '\n';
      return 0;
    }
  uint64_t unique = 0;
  for (auto &x : req) {
    auto y = has(p, x.d);
    if (y->z != x.z) {
      cout << "SIZE " << x.d << '\n';
      return 0;
    }
    unique += x.z;
  }
  cout << "VALID " << req.size() << ' ' << unique << ' ' << total - unique
       << '\n';
}
