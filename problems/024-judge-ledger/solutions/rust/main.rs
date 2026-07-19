use std::io::{self, Read};
fn rmq(t: &[i64], b: usize, mut l: usize, mut r: usize) -> i64 {
    l += b - 1;
    r += b - 1;
    let mut z = 0;
    while l <= r {
        if l & 1 == 1 {
            z = z.max(t[l]);
            l += 1
        }
        if r & 1 == 0 {
            z = z.max(t[r]);
            r -= 1
        }
        l /= 2;
        r /= 2
    }
    z
}
fn main() {
    let mut x = String::new();
    io::stdin().read_to_string(&mut x).unwrap();
    let mut it = x.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let q: usize = it.next().unwrap().parse().unwrap();
    let mut bad = vec![0; n + 2];
    let mut u = vec![vec![0; n + 1]; 4];
    let mut s = vec![vec![0i64; n + 1]; 2];
    let mut b = 1;
    while b < n {
        b *= 2
    }
    let (mut tm, mut tv) = (vec![0i64; 2 * b], vec![0i64; 2 * b]);
    for i in 1..=n {
        bad[i] = it.next().unwrap().parse().unwrap();
        let mut a = [0i64; 4];
        for z in &mut a {
            *z = it.next().unwrap().parse().unwrap()
        }
        for j in 0..4 {
            u[j][i] = u[j][i - 1] + (a[j] < 0) as i32
        }
        for j in 0..2 {
            s[j][i] = s[j][i - 1] + a[j].max(0)
        }
        tm[b + i - 1] = a[2].max(0);
        tv[b + i - 1] = a[3].max(0)
    }
    for i in (1..b).rev() {
        tm[i] = tm[i * 2].max(tm[i * 2 + 1]);
        tv[i] = tv[i * 2].max(tv[i * 2 + 1])
    }
    let mut nb = vec![n + 1; n + 2];
    for i in (1..=n).rev() {
        nb[i] = if bad[i] > 0 { i } else { nb[i + 1] }
    }
    let mut out = String::new();
    for _ in 0..q {
        let l: usize = it.next().unwrap().parse().unwrap();
        let r: usize = it.next().unwrap().parse().unwrap();
        let f: i32 = it.next().unwrap().parse().unwrap();
        let e = if f == 1 && nb[l] <= r { nb[l] } else { r };
        out += &format!("{} {}", e - l + 1, if nb[l] <= e { bad[nb[l]] } else { 0 });
        for j in 0..2 {
            if u[j][e] > u[j][l - 1] {
                out += " null"
            } else {
                out += &format!(" {}", s[j][e] - s[j][l - 1])
            }
        }
        for j in 2..4 {
            if u[j][e] > u[j][l - 1] {
                out += " null"
            } else {
                out += &format!(" {}", rmq(if j == 2 { &tm } else { &tv }, b, l, e))
            }
        }
        out.push('\n')
    }
    print!("{out}")
}
