use std::io::{self, Read};
fn find(p: &mut [usize], mut x: usize) -> usize {
    let mut r = x;
    while p[r] != r {
        r = p[r]
    }
    while p[x] != x {
        let y = p[x];
        p[x] = r;
        x = y
    }
    r
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let m: usize = it.next().unwrap().parse().unwrap();
    let mut e = Vec::with_capacity(m);
    for _ in 0..m {
        let u = it.next().unwrap().parse::<usize>().unwrap() - 1;
        let v = it.next().unwrap().parse::<usize>().unwrap() - 1;
        let w: u64 = it.next().unwrap().parse().unwrap();
        e.push((w, u, v));
    }
    e.sort_by_key(|x| x.0);
    let mut p: Vec<usize> = (0..n).collect();
    let mut sz = vec![1; n];
    let (mut cost, mut take) = (0u64, 0);
    for (w, a, b) in e {
        let (mut u, mut v) = (find(&mut p, a), find(&mut p, b));
        if u == v {
            continue;
        }
        if sz[u] < sz[v] {
            std::mem::swap(&mut u, &mut v)
        }
        p[v] = u;
        sz[u] += sz[v];
        cost += w;
        take += 1;
        if take == n - 1 {
            break;
        }
    }
    if take == n - 1 {
        println!("COST {cost}")
    } else {
        println!("IMPOSSIBLE")
    }
}
