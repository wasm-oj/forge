use std::io::{self, Read};
struct I {
    z: i64,
    p: i32,
    u: i64,
    a: String,
    k: String,
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let n: usize = t.next().unwrap().parse().unwrap();
    let c: i64 = t.next().unwrap().parse().unwrap();
    let a: i64 = t.next().unwrap().parse().unwrap();
    let r: i64 = t.next().unwrap().parse().unwrap();
    let mut v = Vec::with_capacity(n);
    let mut total = 0;
    for _ in 0..n {
        let z = t.next().unwrap().parse().unwrap();
        let p = t.next().unwrap().parse().unwrap();
        let u = t.next().unwrap().parse().unwrap();
        let x = t.next().unwrap().to_string();
        let k = t.next().unwrap().to_string();
        total += z;
        v.push(I { z, p, u, a: x, k })
    }
    let need = 0.max(total - c).max(r - a);
    if need > total {
        println!("IMPOSSIBLE");
        return;
    }
    v.sort_by(|x, y| {
        x.p.cmp(&y.p)
            .then(x.u.cmp(&y.u))
            .then(x.a.cmp(&y.a))
            .then(x.k.cmp(&y.k))
    });
    let (mut f, mut k) = (0, 0);
    while f < need {
        f += v[k].z;
        k += 1
    }
    println!("{k} {f}");
    for x in &v[..k] {
        println!("{} {}", x.a, x.k)
    }
}
