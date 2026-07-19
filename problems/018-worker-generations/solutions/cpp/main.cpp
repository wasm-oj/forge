#include <cstdint>
#include <iostream>
#include <string>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n;
  if (!(cin >> n))
    return 0;
  uint64_t b, used = 0;
  cin >> b;
  string cur;
  int gen = 0, reject = 0;
  while (n--) {
    string f;
    uint64_t s;
    cin >> f >> s;
    if (s == 0) {
      cout << "CACHE\n";
      continue;
    }
    if (s > 8 || s > b) {
      cout << "REJECT\n";
      ++reject;
      continue;
    }
    if (cur != f || used + s > b) {
      cur = f;
      used = 0;
      ++gen;
    }
    used += s;
    cout << "WORKER " << gen << '\n';
  }
  cout << "SUMMARY " << gen << ' ' << reject << '\n';
}
