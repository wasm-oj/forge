use std::io::{self, Read};
struct F {
    p: String,
    v: String,
}
struct C {
    id: String,
    t: u64,
    f: Vec<F>,
}
struct H {
    name: String,
    c: Vec<C>,
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let mut h = Vec::new();
    for _ in 0..n {
        let name = it.next().unwrap().to_string();
        let k: usize = it.next().unwrap().parse().unwrap();
        let mut cs = Vec::new();
        for _ in 0..k {
            let id = it.next().unwrap().to_string();
            let t = it.next().unwrap().parse().unwrap();
            let p: usize = it.next().unwrap().parse().unwrap();
            let mut f = Vec::new();
            for _ in 0..p {
                f.push(F {
                    p: it.next().unwrap().to_string(),
                    v: it.next().unwrap().to_string(),
                })
            }
            cs.push(C { id, t, f })
        }
        h.push(H { name, c: cs })
    }
    let mut all = true;
    let mut out = String::new();
    for z in 1..n {
        let order =
            h[z].c.len() != h[0].c.len() || h[z].c.iter().zip(&h[0].c).any(|(a, b)| a.id != b.id);
        if order {
            out += &format!("HOST {} CASE_ORDER\n", h[z].name);
            all = false;
            continue;
        }
        let mut d = Vec::new();
        for (a, b) in h[0].c.iter().zip(&h[z].c) {
            let (mut x, mut y) = (0, 0);
            while x < a.f.len() || y < b.f.len() {
                if y == b.f.len() || (x < a.f.len() && a.f[x].p < b.f[y].p) {
                    d.push(format!("{}.{}", a.id, a.f[x].p));
                    x += 1
                } else if x == a.f.len() || a.f[x].p > b.f[y].p {
                    d.push(format!("{}.{}", a.id, b.f[y].p));
                    y += 1
                } else {
                    if a.f[x].v != b.f[y].v {
                        d.push(format!("{}.{}", a.id, a.f[x].p))
                    }
                    x += 1;
                    y += 1
                }
            }
        }
        if d.is_empty() {
            out += &format!("HOST {} OK\n", h[z].name)
        } else {
            all = false;
            out += &format!("HOST {} {} {}\n", h[z].name, d.len(), d.join(" "))
        }
    }
    if all {
        for i in 0..h[0].c.len() {
            let mut v: Vec<u64> = h.iter().map(|x| x.c[i].t).collect();
            v.sort();
            out += &format!("MEDIAN {} {}\n", h[0].c[i].id, v[(n - 1) / 2])
        }
    }
    print!("{out}")
}
