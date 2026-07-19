#include <algorithm>
#include <iostream>
#include <string>
#include <vector>
using namespace std;

struct Node {
  int first_child;
  int next_sibling;
  int exact_min;
  int file_min;
  int desc_min;
  unsigned char ch;
};

int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);

  int n;
  if (!(cin >> n))
    return 0;
  const int infinity = n + 1;
  vector<Node> nodes(1, {0, 0, infinity, infinity, infinity, 0});

  auto find_or_create_child = [&](int parent, unsigned char ch) {
    for (int child = nodes[parent].first_child; child != 0;
         child = nodes[child].next_sibling) {
      if (nodes[child].ch == ch)
        return child;
    }
    int child = static_cast<int>(nodes.size());
    int next_sibling = nodes[parent].first_child;
    nodes.push_back({0, next_sibling, infinity, infinity, infinity, ch});
    nodes[parent].first_child = child;
    return child;
  };

  for (int j = 1; j <= n; ++j) {
    char kind;
    string path;
    cin >> kind >> path;
    vector<int> visited;
    visited.reserve(path.size());
    int current = 0;
    int best = infinity;

    for (size_t position = 0; position < path.size(); ++position) {
      current = find_or_create_child(
          current, static_cast<unsigned char>(path[position]));
      visited.push_back(current);
      if (position + 1 < path.size() &&
          (position == 0 || path[position + 1] == '/')) {
        best = min(best, nodes[current].file_min);
      }
    }
    best = min(best, nodes[current].exact_min);
    if (kind == 'F')
      best = min(best, nodes[current].desc_min);

    if (best != infinity) {
      cout << "CONFLICT " << best << ' ' << j << '\n';
      return 0;
    }

    for (size_t position = 0; position + 1 < path.size(); ++position) {
      if (position == 0 || path[position + 1] == '/')
        nodes[visited[position]].desc_min =
            min(nodes[visited[position]].desc_min, j);
    }
    nodes[current].exact_min = min(nodes[current].exact_min, j);
    if (kind == 'F')
      nodes[current].file_min = min(nodes[current].file_min, j);
  }

  cout << "VALID\n";
}
