use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let q: usize = it.next().unwrap().parse().unwrap();
    let c: u64 = it.next().unwrap().parse().unwrap();
    let mut pi = vec![0u64; n + 1];
    let mut pm = vec![0u64; n + 1];
    let mut bad = vec![false; n + 2];
    for i in 1..=n {
        let k: u32 = it.next().unwrap().parse().unwrap();
        let x: u64 = it.next().unwrap().parse().unwrap();
        let m: i64 = it.next().unwrap().parse().unwrap();
        bad[i] = k == 64 || x > c || (m >= 0 && (m as u64) < x);
        pi[i] = pi[i - 1];
        pm[i] = pm[i - 1];
        if !bad[i] {
            pi[i] += x;
            pm[i] += if m < 0 { c } else { c.min(m as u64) };
        }
    }
    let mut nxt = vec![n + 1; n + 2];
    for i in (1..=n).rev() {
        nxt[i] = if bad[i] { i } else { nxt[i + 1] };
    }
    let mut out = String::new();
    for _ in 0..q {
        let l: usize = it.next().unwrap().parse().unwrap();
        let r: usize = it.next().unwrap().parse().unwrap();
        if nxt[l] <= r {
            out += &format!("REJECT {}\n", nxt[l]);
        } else {
            out += &format!(
                "ACCEPT {} {}\n",
                (pi[r] - pi[l - 1]) * 65536,
                (pm[r] - pm[l - 1]) * 65536
            );
        }
    }
    print!("{}", out);
}
