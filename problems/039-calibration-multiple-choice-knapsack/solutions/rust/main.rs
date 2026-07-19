use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let g: usize = t.next().unwrap().parse().unwrap();
    let cmax: usize = t.next().unwrap().parse().unwrap();
    let mut dp = vec![0u64; cmax + 1];
    for _ in 0..g {
        let k: usize = t.next().unwrap().parse().unwrap();
        let mut a = Vec::with_capacity(k);
        for _ in 0..k {
            a.push((
                t.next().unwrap().parse::<usize>().unwrap(),
                t.next().unwrap().parse::<u64>().unwrap(),
            ));
        }
        let mut next = dp.clone();
        for (w, v) in a {
            for c in w..=cmax {
                next[c] = next[c].max(dp[c - w] + v);
            }
        }
        dp = next;
    }
    println!("{}", dp[cmax]);
}
