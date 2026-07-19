use std::collections::VecDeque;
use std::io::{self, Read};
#[derive(Clone, Copy)]
struct E {
    to: usize,
    rev: usize,
    cap: u64,
}
struct Dinic {
    g: Vec<Vec<E>>,
    level: Vec<i32>,
    it: Vec<usize>,
    t: usize,
}
impl Dinic {
    fn new(n: usize, t: usize) -> Self {
        Self {
            g: vec![vec![]; n],
            level: vec![-1; n],
            it: vec![0; n],
            t,
        }
    }
    fn add(&mut self, u: usize, v: usize, c: u64) {
        let (a, b) = (self.g[u].len(), self.g[v].len());
        self.g[u].push(E {
            to: v,
            rev: b,
            cap: c,
        });
        self.g[v].push(E {
            to: u,
            rev: a,
            cap: 0,
        });
    }
    fn dfs(&mut self, u: usize, f: u64) -> u64 {
        if u == self.t {
            return f;
        }
        while self.it[u] < self.g[u].len() {
            let i = self.it[u];
            let e = self.g[u][i];
            if e.cap > 0 && self.level[e.to] == self.level[u] + 1 {
                let z = self.dfs(e.to, f.min(e.cap));
                if z > 0 {
                    self.g[u][i].cap -= z;
                    self.g[e.to][e.rev].cap += z;
                    return z;
                }
            }
            self.it[u] += 1
        }
        0
    }
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut x = s.split_whitespace();
    let n: usize = x.next().unwrap().parse().unwrap();
    let m: usize = x.next().unwrap().parse().unwrap();
    let sn: usize = x.next().unwrap().parse().unwrap();
    let tn: usize = x.next().unwrap().parse().unwrap();
    let c: Vec<u64> = (0..n).map(|_| x.next().unwrap().parse().unwrap()).collect();
    let en: Vec<usize> = (0..sn)
        .map(|_| x.next().unwrap().parse::<usize>().unwrap() - 1)
        .collect();
    let dn: Vec<usize> = (0..tn)
        .map(|_| x.next().unwrap().parse::<usize>().unwrap() - 1)
        .collect();
    let (v, s, t) = (2 * n + 2, 2 * n, 2 * n + 1);
    let mut d = Dinic::new(v, t);
    let inf = c.iter().sum::<u64>() + 1;
    for (i, &z) in c.iter().enumerate() {
        d.add(2 * i, 2 * i + 1, z)
    }
    for _ in 0..m {
        let u = x.next().unwrap().parse::<usize>().unwrap() - 1;
        let w = x.next().unwrap().parse::<usize>().unwrap() - 1;
        d.add(2 * u + 1, 2 * w, inf)
    }
    for u in en {
        d.add(s, 2 * u, inf)
    }
    for u in dn {
        d.add(2 * u + 1, t, inf)
    }
    let mut flow = 0;
    loop {
        d.level.fill(-1);
        d.level[s] = 0;
        let mut q = VecDeque::from([s]);
        while let Some(u) = q.pop_front() {
            for e in &d.g[u] {
                if e.cap > 0 && d.level[e.to] < 0 {
                    d.level[e.to] = d.level[u] + 1;
                    q.push_back(e.to)
                }
            }
        }
        if d.level[t] < 0 {
            break;
        }
        d.it.fill(0);
        loop {
            let z = d.dfs(s, inf);
            if z == 0 {
                break;
            }
            flow += z
        }
    }
    println!("COST {flow}");
}
