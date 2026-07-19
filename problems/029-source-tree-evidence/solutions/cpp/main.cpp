#include <algorithm>
#include <iostream>
#include <string>
#include <vector>
struct R {
  std::string p, line;
};
int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  int n;
  std::string e, line;
  std::cin >> n >> e;
  std::getline(std::cin, line);
  std::vector<R> a;
  while (n--) {
    std::getline(std::cin, line);
    std::string::size_type z = line.find(' ', 2);
    std::string p = line.substr(2, z - 2);
    if (p == e || (p.size() > e.size() && p.compare(0, e.size(), e) == 0 &&
                   p[e.size()] == '/'))
      continue;
    a.push_back({p, line});
  }
  std::sort(a.begin(), a.end(),
            [](const R &x, const R &y) { return x.p < y.p; });
  std::cout << a.size() << '\n';
  for (auto &x : a)
    std::cout << x.line << '\n';
}
