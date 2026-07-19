use std::io::{self, Read};
fn main() {
    let mut x = String::new();
    io::stdin().read_to_string(&mut x).unwrap();
    let mut it = x.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let b: u64 = it.next().unwrap().parse().unwrap();
    let (mut generation, mut used, mut reject) = (0, 0u64, 0);
    let mut family = "";
    let mut out = String::new();
    for _ in 0..n {
        let f = it.next().unwrap();
        let s: u64 = it.next().unwrap().parse().unwrap();
        if s == 0 {
            out.push_str("CACHE\n")
        } else if s > 8 || s > b {
            reject += 1;
            out.push_str("REJECT\n")
        } else {
            if family != f || used + s > b {
                generation += 1;
                family = f;
                used = 0
            }
            used += s;
            out.push_str(&format!("WORKER {generation}\n"));
        }
    }
    out.push_str(&format!("SUMMARY {generation} {reject}\n"));
    print!("{out}");
}
