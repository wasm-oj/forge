#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int p, n, limit;
  if (!(cin >> p >> n))
    return 0;
  uint64_t cap;
  cin >> cap >> limit;
  vector<char> ex(p + 1);
  vector<uint64_t> sz(p + 1);
  uint64_t used = 0, peakb = 0;
  int ino = 0, peaki = 0, sticky = 0;
  while (n--) {
    string op, err;
    int x;
    cin >> op >> x;
    if (op == "CREATE") {
      if (ex[x])
        err = "EXISTS";
      else if (ino == limit)
        err = "INODES";
      else
        ex[x] = 1, sz[x] = 0, ino++;
    } else if (op == "UNLINK") {
      if (!ex[x])
        err = "NOENT";
      else
        used -= sz[x], sz[x] = 0, ex[x] = 0, ino--;
    } else {
      uint64_t v;
      if (op == "WRITE") {
        uint64_t off, len;
        cin >> off >> len;
        v = len ? max(sz[x], off + len) : sz[x];
      } else
        cin >> v;
      if (!ex[x])
        err = "NOENT";
      else if (v > sz[x] && v - sz[x] > cap - used)
        err = "BYTES";
      else {
        if (v >= sz[x])
          used += v - sz[x];
        else
          used -= sz[x] - v;
        sz[x] = v;
      }
    }
    if (err.empty())
      cout << "OK\n";
    else {
      cout << "ERR " << err << '\n';
      if (err == "BYTES" || err == "INODES")
        sticky = 1;
    }
    peakb = max(peakb, used);
    peaki = max(peaki, ino);
  }
  cout << "SUMMARY " << used << ' ' << ino << ' ' << peakb << ' ' << peaki
       << ' ' << sticky << '\n';
}
