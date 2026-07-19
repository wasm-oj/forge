use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let p: usize = it.next().unwrap().parse().unwrap();
    let seeds: usize = it.next().unwrap().parse().unwrap();
    let n: usize = it.next().unwrap().parse().unwrap();
    let q: usize = it.next().unwrap().parse().unwrap();
    let mut c = vec![0usize; p + 1];
    let mut lo = vec![u64::MAX; p + 1];
    let mut hi = vec![0u64; p + 1];
    for _ in 0..n {
        let x: usize = it.next().unwrap().parse().unwrap();
        it.next();
        let v: u64 = it.next().unwrap().parse().unwrap();
        c[x] += 1;
        lo[x] = lo[x].min(v);
        hi[x] = hi[x].max(v);
    }
    let mut out = String::new();
    for _ in 0..q {
        let x: usize = it.next().unwrap().parse().unwrap();
        let raw: u64 = it.next().unwrap().parse().unwrap();
        if c[x] != seeds || lo[x] != hi[x] {
            out += "INVALID\n"
        } else {
            out += &format!("{} {}\n", lo[x], raw.saturating_sub(lo[x]));
        }
    }
    print!("{}", out);
}
