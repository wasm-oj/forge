#include <iostream>
#include <string>
#include <unordered_map>
using namespace std;

int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);

  int n, k;
  if (!(cin >> n >> k))
    return 0;
  unordered_map<string, int> last_index;
  last_index.reserve(static_cast<size_t>(n) * 2);
  int hits = 0;
  for (int index = 1; index <= n; ++index) {
    string fingerprint;
    cin >> fingerprint;
    auto found = last_index.find(fingerprint);
    if (found != last_index.end() && index - found->second <= k)
      ++hits;
    last_index[fingerprint] = index;
  }
  cout << hits << '\n';
}
