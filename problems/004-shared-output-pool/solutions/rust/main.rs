use std::io::{self, Read};
fn main() {
    let mut x = String::new();
    io::stdin().read_to_string(&mut x).unwrap();
    let mut t = x.split_whitespace();
    let n: usize = t.next().unwrap().parse().unwrap();
    let q: usize = t.next().unwrap().parse().unwrap();
    let mut s = Vec::with_capacity(n);
    let mut a = Vec::with_capacity(n);
    for _ in 0..n {
        s.push(t.next().unwrap().as_bytes()[0]);
        a.push(t.next().unwrap().parse::<u64>().unwrap());
    }
    let (mut i, mut used, mut c) = (0usize, 0u64, [0u64; 3]);
    let mut out = String::new();
    for _ in 0..q {
        let b: u64 = t.next().unwrap().parse().unwrap();
        while i < n && a[i] <= b - used {
            used += a[i];
            let k = if s[i] == b'O' {
                0
            } else if s[i] == b'E' {
                1
            } else {
                2
            };
            c[k] += a[i];
            i += 1;
        }
        let mut d = c;
        let fail = if i == n {
            0
        } else {
            let k = if s[i] == b'O' {
                0
            } else if s[i] == b'E' {
                1
            } else {
                2
            };
            d[k] += b - used;
            i + 1
        };
        out += &format!("{} {} {} {}\n", fail, d[0], d[1], d[2]);
    }
    print!("{}", out);
}
