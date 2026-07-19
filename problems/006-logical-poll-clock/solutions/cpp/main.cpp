#include <cstdint>
#include <functional>
#include <iostream>
#include <queue>
#include <utility>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n;
  if (!(cin >> n))
    return 0;
  priority_queue<pair<uint64_t, int>, vector<pair<uint64_t, int>>,
                 greater<pair<uint64_t, int>>>
      h;
  vector<char> a(n + 1);
  uint64_t clock = 0;
  while (n--) {
    char op;
    cin >> op;
    if (op == 'T') {
      int id;
      uint64_t d;
      cin >> id >> d;
      a[id] = 1;
      h.push({d, id});
    } else if (op == 'C') {
      int id;
      cin >> id;
      a[id] = 0;
    } else {
      int ready;
      cin >> ready;
      while (!h.empty() && !a[h.top().second])
        h.pop();
      if (!ready && !h.empty())
        clock = max(clock, h.top().first);
      vector<int> f;
      while (!h.empty() && h.top().first <= clock) {
        auto [d, id] = h.top();
        h.pop();
        if (a[id]) {
          a[id] = 0;
          f.push_back(id);
        }
      }
      cout << clock << ' ' << ready << ' ' << f.size();
      for (int id : f)
        cout << ' ' << id;
      cout << '\n';
    }
  }
}
