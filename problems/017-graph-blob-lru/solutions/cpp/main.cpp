#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, d, q;
  uint64_t cap;
  if (!(cin >> n >> d >> q >> cap))
    return 0;
  vector<uint64_t> sz(d);
  for (auto &x : sz)
    cin >> x;
  vector<int> lp(d, -1), ln(d, -1), rh(d, -1), node(n, -1), rp(n, -1),
      rn(n, -1);
  vector<char> cached(d);
  int head = -1, tail = -1;
  uint64_t used = 0;
  auto remove_lru = [&](int x) {
    if (lp[x] >= 0)
      ln[lp[x]] = ln[x];
    else
      head = ln[x];
    if (ln[x] >= 0)
      lp[ln[x]] = lp[x];
    else
      tail = lp[x];
    lp[x] = ln[x] = -1;
  };
  auto touch = [&](int x) {
    if (cached[x])
      remove_lru(x);
    cached[x] = 1;
    lp[x] = tail;
    if (tail >= 0)
      ln[tail] = x;
    else
      head = x;
    tail = x;
  };
  auto detach = [&](int u) {
    int x = node[u];
    if (x < 0)
      return;
    if (rp[u] >= 0)
      rn[rp[u]] = rn[u];
    else
      rh[x] = rn[u];
    if (rn[u] >= 0)
      rp[rn[u]] = rp[u];
    node[u] = rp[u] = rn[u] = -1;
  };
  auto attach = [&](int u, int x) {
    node[u] = x;
    rn[u] = rh[x];
    if (rh[x] >= 0)
      rp[rh[x]] = u;
    rh[x] = u;
    rp[u] = -1;
  };
  while (q--) {
    char op;
    int u;
    cin >> op >> u;
    --u;
    if (op == 'G') {
      if (node[u] < 0)
        cout << "MISS\n";
      else {
        touch(node[u]);
        cout << "HIT " << node[u] + 1 << '\n';
      }
      continue;
    }
    int x;
    cin >> x;
    --x;
    detach(u);
    if (sz[x] > cap)
      continue;
    if (!cached[x])
      used += sz[x];
    touch(x);
    attach(u, x);
    while (used > cap) {
      int dead = head;
      remove_lru(dead);
      cached[dead] = 0;
      used -= sz[dead];
      for (int v = rh[dead]; v >= 0;) {
        int z = rn[v];
        node[v] = rp[v] = rn[v] = -1;
        v = z;
      }
      rh[dead] = -1;
    }
  }
}
