#include <iostream>
#include <string>
#include <string_view>
#include <vector>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n;
  if (!(cin >> n))
    return 0;
  while (n--) {
    string s;
    cin >> s;
    vector<string_view> st;
    bool bad = false;
    size_t b = 1;
    for (size_t i = 1; i <= s.size(); i++)
      if (i == s.size() || s[i] == '/') {
        string_view x(s.data() + b, i - b);
        if (x.empty() || x == ".") {
        } else if (x == "..") {
          if (st.empty()) {
            bad = true;
            break;
          }
          st.pop_back();
        } else
          st.push_back(x);
        b = i + 1;
      }
    if (bad)
      cout << "INVALID\n";
    else if (st.empty())
      cout << "/\n";
    else {
      for (auto x : st)
        cout << '/' << x;
      cout << '\n';
    }
  }
}
