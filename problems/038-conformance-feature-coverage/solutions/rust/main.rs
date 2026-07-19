use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let f: usize = t.next().unwrap().parse().unwrap();
    let n: usize = t.next().unwrap().parse().unwrap();
    let b: u64 = t.next().unwrap().parse().unwrap();
    let states = 1usize << f;
    let inf = u64::MAX / 4;
    let mut dp = vec![inf; states];
    dp[0] = 0;
    for _ in 0..n {
        let cost: u64 = t.next().unwrap().parse().unwrap();
        let k: usize = t.next().unwrap().parse().unwrap();
        let mut m = 0usize;
        for _ in 0..k {
            let x: usize = t.next().unwrap().parse().unwrap();
            m |= 1 << (x - 1);
        }
        let mut next = dp.clone();
        for mask in 0..states {
            if dp[mask] != inf {
                let q = mask | m;
                next[q] = next[q].min(dp[mask] + cost);
            }
        }
        dp = next;
    }
    let mut ans = 0;
    for mask in 0..states {
        if dp[mask] <= b {
            ans = ans.max(mask.count_ones());
        }
    }
    println!("{}", ans);
}
