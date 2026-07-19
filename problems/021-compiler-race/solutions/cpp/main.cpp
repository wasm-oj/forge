#include <iostream>
#include <string>
#include <unordered_map>
#include <vector>
struct Job {
  std::string key;
  int epoch;
  char kind;
  bool alive;
};
int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  int n;
  std::cin >> n;
  std::unordered_map<std::string, int> by;
  std::vector<Job> a(1);
  int ep = 0, bg = 0;
  while (n--) {
    char t;
    std::cin >> t;
    if (t == 'B' || t == 'F') {
      std::string k;
      std::cin >> k;
      int id = by.count(k) ? by[k] : 0;
      bool live = id && a[id].alive && (a[id].kind == 'F' || a[id].epoch == ep);
      if (live)
        std::cout << "JOIN " << id << '\n';
      else {
        a.push_back({k, ep, t, true});
        id = (int)a.size() - 1;
        by[k] = id;
        if (t == 'B')
          bg++;
        std::cout << "NEW " << id << '\n';
      }
    } else if (t == 'S') {
      std::cout << "CANCEL " << bg << '\n';
      bg = 0;
      ep++;
    } else {
      int id;
      std::cin >> id;
      bool live = id < (int)a.size() && a[id].alive &&
                  (a[id].kind == 'F' || a[id].epoch == ep);
      if (!live)
        std::cout << "STALE\n";
      else {
        a[id].alive = false;
        if (a[id].kind == 'B')
          bg--;
        if (by[a[id].key] == id)
          by.erase(a[id].key);
        std::cout << "DONE\n";
      }
    }
  }
}
