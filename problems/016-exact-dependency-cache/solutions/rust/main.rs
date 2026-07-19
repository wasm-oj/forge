use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let h: usize = it.next().unwrap().parse().unwrap();
    let m: usize = it.next().unwrap().parse().unwrap();
    let q: usize = it.next().unwrap().parse().unwrap();
    let w = n.div_ceil(64);
    let mut b = vec![vec![0u64; w]; h];
    for _ in 0..m {
        let s = it.next().unwrap().parse::<usize>().unwrap() - 1;
        let x = it.next().unwrap().parse::<usize>().unwrap() - 1;
        b[x][s / 64] |= 1u64 << (s % 64);
    }
    let mut out = String::new();
    for _ in 0..q {
        let k: usize = it.next().unwrap().parse().unwrap();
        let mut v = vec![0u64; w];
        for _ in 0..k {
            let x = it.next().unwrap().parse::<usize>().unwrap() - 1;
            for j in 0..w {
                v[j] |= b[x][j]
            }
        }
        let ans: u32 = v.iter().map(|x| x.count_ones()).sum();
        out.push_str(&format!("{ans}\n"));
    }
    print!("{out}");
}
