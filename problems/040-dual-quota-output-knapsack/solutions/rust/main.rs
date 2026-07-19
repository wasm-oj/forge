use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let n: usize = t.next().unwrap().parse().unwrap();
    let bmax: usize = t.next().unwrap().parse().unwrap();
    let imax: usize = t.next().unwrap().parse().unwrap();
    let mut dp = vec![vec![0u64; bmax + 1]; imax + 1];
    for _ in 0..n {
        let b: usize = t.next().unwrap().parse().unwrap();
        let e: usize = t.next().unwrap().parse().unwrap();
        let v: u64 = t.next().unwrap().parse().unwrap();
        for x in (e..=imax).rev() {
            for y in (b..=bmax).rev() {
                dp[x][y] = dp[x][y].max(dp[x - e][y - b] + v);
            }
        }
    }
    println!("{}", dp[imax][bmax]);
}
