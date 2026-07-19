#include <array>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

static int verdict_index(char value) {
    if (value == 'A') return 0;
    if (value == 'W') return 1;
    if (value == 'R') return 2;
    return 3;
}

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    int n, q;
    std::string verdicts;
    if (!(std::cin >> n >> q >> verdicts)) return 1;
    std::vector<std::array<std::uint32_t, 4>> prefix(static_cast<std::size_t>(n) + 1);
    for (int i = 1; i <= n; ++i) {
        prefix[static_cast<std::size_t>(i)] = prefix[static_cast<std::size_t>(i - 1)];
        ++prefix[static_cast<std::size_t>(i)][static_cast<std::size_t>(verdict_index(verdicts[static_cast<std::size_t>(i - 1)]))];
    }
    for (int query = 0; query < q; ++query) {
        int left, right;
        char verdict;
        std::cin >> left >> right >> verdict;
        const auto kind = static_cast<std::size_t>(verdict_index(verdict));
        std::cout << prefix[static_cast<std::size_t>(right)][kind]
                         - prefix[static_cast<std::size_t>(left - 1)][kind]
                  << '\n';
    }
    return 0;
}
