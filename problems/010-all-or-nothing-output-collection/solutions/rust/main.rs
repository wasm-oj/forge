use std::io::{self, Read};
struct File {
    p: String,
    m: u64,
    a: u64,
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let n: usize = t.next().unwrap().parse().unwrap();
    let q: usize = t.next().unwrap().parse().unwrap();
    let u: u64 = t.next().unwrap().parse().unwrap();
    let mut f = Vec::with_capacity(n);
    for _ in 0..n {
        f.push(File {
            p: t.next().unwrap().to_string(),
            m: t.next().unwrap().parse().unwrap(),
            a: t.next().unwrap().parse().unwrap(),
        });
    }
    f.sort_by(|a, b| a.p.cmp(&b.p));
    let mut pre = vec![0u64; n + 1];
    let mut mismatch = n;
    for i in 0..n {
        pre[i + 1] = pre[i] + f[i].m;
        if mismatch == n && f[i].m != f[i].a {
            mismatch = i;
        }
    }
    let mut k = 0usize;
    let mut out = String::new();
    for _ in 0..q {
        let b: u64 = t.next().unwrap().parse().unwrap();
        if b < u {
            out += "ERR QUOTA -\n";
            continue;
        }
        let cap = b - u;
        while k < n && pre[k + 1] <= cap {
            k += 1
        }
        if k < mismatch {
            out += &format!("ERR QUOTA {}\n", f[k].p)
        } else if mismatch < n {
            out += &format!("ERR MISMATCH {}\n", f[mismatch].p)
        } else if k < n {
            out += &format!("ERR QUOTA {}\n", f[k].p)
        } else {
            out += &format!("OK {} {}\n", n, u + pre[n])
        }
    }
    print!("{}", out);
}
