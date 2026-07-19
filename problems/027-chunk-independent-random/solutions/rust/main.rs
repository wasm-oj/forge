use std::io::{self, Read};
fn byte(s: u64, x: u64) -> u64 {
    let mut z = s.wrapping_add(0x9e3779b97f4a7c15u64.wrapping_mul(x / 8 + 1));
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^= z >> 31;
    (z >> (8 * (x % 8))) & 255
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let a = t.next().unwrap().parse().unwrap();
    let b = t.next().unwrap().parse().unwrap();
    let lim = t.next().unwrap().parse().unwrap();
    let q: usize = t.next().unwrap().parse().unwrap();
    let mut p = 0u64;
    let at = |x| {
        if x < lim {
            byte(a, x)
        } else {
            byte(b, x - lim)
        }
    };
    let mut out = String::new();
    for _ in 0..q {
        let k: u64 = t.next().unwrap().parse().unwrap();
        out += &format!("{} {}\n", at(p), at(p + k - 1));
        p += k
    }
    print!("{out}")
}
