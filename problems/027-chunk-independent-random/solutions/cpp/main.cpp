#include <cstdint>
#include <iostream>
unsigned at(std::uint64_t s, std::uint64_t x) {
  std::uint64_t z = s + UINT64_C(0x9e3779b97f4a7c15) * (x / 8 + 1);
  z = (z ^ (z >> 30)) * UINT64_C(0xbf58476d1ce4e5b9);
  z = (z ^ (z >> 27)) * UINT64_C(0x94d049bb133111eb);
  z ^= z >> 31;
  return (z >> (8 * (x % 8))) & 255;
}
int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  std::uint64_t a, b, S, pos = 0;
  int q;
  std::cin >> a >> b >> S >> q;
  while (q--) {
    std::uint64_t k;
    std::cin >> k;
    unsigned f = pos < S ? at(a, pos) : at(b, pos - S);
    std::uint64_t p = pos + k - 1;
    unsigned l = p < S ? at(a, p) : at(b, p - S);
    std::cout << f << ' ' << l << '\n';
    pos += k;
  }
}
