#include <cstdint>
#include <iostream>
#include <queue>
#include <vector>

struct Case {
    std::uint64_t cost;
    int index;
};

static bool better(const Case &left, const Case &right) {
    return left.cost > right.cost || (left.cost == right.cost && left.index < right.index);
}

struct BetterComparator {
    bool operator()(const Case &left, const Case &right) const {
        return better(left, right);
    }
};

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    int n, k;
    if (!(std::cin >> n >> k)) return 1;
    std::priority_queue<Case, std::vector<Case>, BetterComparator> heap;
    for (int index = 1; index <= n; ++index) {
        std::uint64_t cost;
        std::cin >> cost;
        Case candidate{cost, index};
        if (static_cast<int>(heap.size()) < k) {
            heap.push(candidate);
        } else if (better(candidate, heap.top())) {
            heap.pop();
            heap.push(candidate);
        }
        if (index >= k) std::cout << heap.top().index << ' ' << heap.top().cost << '\n';
    }
    return 0;
}
