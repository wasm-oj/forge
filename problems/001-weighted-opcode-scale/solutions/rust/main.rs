use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let k: usize = it.next().unwrap().parse().unwrap();
    let w_n: usize = it.next().unwrap().parse().unwrap();
    let r: usize = it.next().unwrap().parse().unwrap();
    let q: usize = it.next().unwrap().parse().unwrap();
    let mut w = vec![1000u64; k + 1];
    for _ in 0..w_n {
        let id: usize = it.next().unwrap().parse().unwrap();
        w[id] = it.next().unwrap().parse().unwrap();
    }
    let (mut pc, mut pn, mut rw, mut rc) = (
        vec![0u64; r + 1],
        vec![0u64; r + 1],
        vec![0u64; r],
        vec![0u64; r],
    );
    for i in 0..r {
        let id: usize = it.next().unwrap().parse().unwrap();
        rc[i] = it.next().unwrap().parse().unwrap();
        rw[i] = w[id];
        pc[i + 1] = pc[i] + rw[i] * rc[i];
        pn[i + 1] = pn[i] + rc[i];
    }
    let mut out = String::new();
    for _ in 0..q {
        let b: u64 = it.next().unwrap().parse().unwrap();
        let mut lo = 0usize;
        let mut hi = r + 1;
        while lo + 1 < hi {
            let m = (lo + hi) / 2;
            if pc[m] <= b { lo = m } else { hi = m }
        }
        let (mut done, mut cost) = (pn[lo], pc[lo]);
        if lo < r {
            let take = rc[lo].min((b - cost) / rw[lo]);
            done += take;
            cost += take * rw[lo];
        }
        out += &format!("{} {}\n", done, cost);
    }
    print!("{}", out);
}
