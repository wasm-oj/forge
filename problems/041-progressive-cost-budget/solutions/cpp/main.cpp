#include <cstdint>
#include <iostream>
#include <vector>

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);

    std::size_t n, q;
    std::cin >> n >> q;
    std::vector<std::uint64_t> costs(n);
    for (auto &cost : costs) {
        std::cin >> cost;
    }

    std::size_t completed = 0;
    std::uint64_t spent = 0;
    for (std::size_t query = 0; query < q; ++query) {
        std::uint64_t budget;
        std::cin >> budget;
        while (completed < n && costs[completed] <= budget - spent) {
            spent += costs[completed++];
        }
        std::cout << completed << '\n';
    }
}
