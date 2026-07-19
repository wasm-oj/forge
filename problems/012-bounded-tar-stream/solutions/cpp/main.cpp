#include <cctype>
#include <iostream>
#include <string>
using namespace std;
using U = unsigned long long;
bool ok(const string &s) {
  if (s.empty() || s.front() == '/' || s.back() == '/')
    return false;
  size_t p = 0;
  while (p < s.size()) {
    size_t q = s.find('/', p);
    if (q == string::npos)
      q = s.size();
    string x = s.substr(p, q - p);
    if (x.empty() || x == "." || x == "..")
      return false;
    for (char c : x)
      if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' ||
            c == '_' || c == '-'))
        return false;
    p = q + 1;
  }
  return true;
}
int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n;
  U ln, lb;
  if (!(cin >> n >> ln >> lb))
    return 0;
  U off = 0, cnt = 0, used = 0;
  string pending;
  for (int i = 1; i <= n; i++) {
    U got, z, a, b;
    char t;
    string name, err;
    cin >> got >> t >> name >> z >> a >> b;
    if (got != off)
      err = "OFFSET";
    else if (a != b)
      err = "CHECKSUM";
    else if (string("FDGP").find(t) == string::npos)
      err = "TYPE";
    else if ((t == 'G' || t == 'P') && !pending.empty())
      err = "STATE";
    else if ((t == 'G' || t == 'P') && z != name.size() + 1)
      err = "META_SIZE";
    else if ((t == 'G' || t == 'P') && !ok(name))
      err = "PATH";
    else if ((t == 'F' || t == 'D') && !ok(pending.empty() ? name : pending))
      err = "PATH";
    else if (t == 'D' && z)
      err = "ENTRY_SIZE";
    else if (t == 'F' && (cnt == ln || z > lb - used))
      err = "LIMIT";
    if (!err.empty()) {
      cout << "REJECT " << i << ' ' << err << '\n';
      return 0;
    }
    off += 512 + ((z + 511) / 512) * 512;
    if (t == 'G' || t == 'P')
      pending = name;
    else {
      pending.clear();
      if (t == 'F') {
        cnt++;
        used += z;
      }
    }
  }
  if (!pending.empty())
    cout << "REJECT " << n + 1 << " STATE\n";
  else
    cout << "ACCEPT " << cnt << ' ' << used << ' ' << off << '\n';
}
