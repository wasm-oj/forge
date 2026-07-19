#include <iostream>
#include <string>
#include <unordered_map>
using namespace std;

int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);

  int n;
  if (!(cin >> n))
    return 0;
  unordered_map<string, int> first_index;
  first_index.reserve(static_cast<size_t>(n) * 2);
  for (int index = 1; index <= n; ++index) {
    string fingerprint;
    cin >> fingerprint;
    auto [it, inserted] = first_index.emplace(fingerprint, index);
    if (!inserted) {
      cout << index << ' ' << it->second << '\n';
      return 0;
    }
  }
  cout << "NONE\n";
}
