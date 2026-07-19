use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let n: usize = t.next().unwrap().parse().unwrap();
    let c: usize = t.next().unwrap().parse().unwrap();
    let mut dp = vec![0u64; c + 1];
    for _ in 0..n {
        let w: usize = t.next().unwrap().parse().unwrap();
        let v: u64 = t.next().unwrap().parse().unwrap();
        for x in (w..=c).rev() {
            dp[x] = dp[x].max(dp[x - w] + v);
        }
    }
    println!("{}", dp[c]);
}
