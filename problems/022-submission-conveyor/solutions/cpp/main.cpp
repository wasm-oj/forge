#include <deque>
#include <iostream>
#include <unordered_map>
int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  int n, active = 0, waiting = 0;
  std::cin >> n;
  std::deque<int> q;
  std::unordered_map<int, int> s;
  auto advance = [&] {
    while (!active && !q.empty()) {
      int x = q.front();
      q.pop_front();
      if (s[x] == 1) {
        s[x] = 2;
        active = x;
        waiting--;
      }
    }
  };
  while (n--) {
    char t;
    std::cin >> t;
    if (t == 'A') {
      int x;
      std::cin >> x;
      if (!active) {
        active = x;
        s[x] = 2;
      } else {
        s[x] = 1;
        q.push_back(x);
        waiting++;
      }
    } else if (t == 'C') {
      int x;
      std::cin >> x;
      if (s[x] == 1) {
        s[x] = 3;
        waiting--;
      } else if (s[x] == 2) {
        s[x] = 3;
        active = 0;
      }
    } else if (active) {
      s[active] = 3;
      active = 0;
    }
    advance();
    std::cout << active << ' ' << waiting << '\n';
  }
}
