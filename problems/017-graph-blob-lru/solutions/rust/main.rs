use std::io::{self, Read};
struct Cache {
    cap: u64,
    size: Vec<u64>,
    used: u64,
    cached: Vec<bool>,
    lp: Vec<isize>,
    ln: Vec<isize>,
    rh: Vec<isize>,
    node: Vec<isize>,
    rp: Vec<isize>,
    rn: Vec<isize>,
    head: isize,
    tail: isize,
}
impl Cache {
    fn lr(&mut self, x: usize) {
        let (a, b) = (self.lp[x], self.ln[x]);
        if a >= 0 {
            self.ln[a as usize] = b
        } else {
            self.head = b
        }
        if b >= 0 {
            self.lp[b as usize] = a
        } else {
            self.tail = a
        }
        self.lp[x] = -1;
        self.ln[x] = -1;
    }
    fn touch(&mut self, x: usize) {
        if self.cached[x] {
            self.lr(x)
        }
        self.cached[x] = true;
        self.lp[x] = self.tail;
        if self.tail >= 0 {
            self.ln[self.tail as usize] = x as isize
        } else {
            self.head = x as isize
        }
        self.tail = x as isize;
    }
    fn detach(&mut self, u: usize) {
        let x = self.node[u];
        if x < 0 {
            return;
        }
        let (a, b) = (self.rp[u], self.rn[u]);
        if a >= 0 {
            self.rn[a as usize] = b
        } else {
            self.rh[x as usize] = b
        }
        if b >= 0 {
            self.rp[b as usize] = a
        }
        self.node[u] = -1;
        self.rp[u] = -1;
        self.rn[u] = -1;
    }
    fn attach(&mut self, u: usize, x: usize) {
        self.node[u] = x as isize;
        self.rn[u] = self.rh[x];
        if self.rh[x] >= 0 {
            self.rp[self.rh[x] as usize] = u as isize
        }
        self.rh[x] = u as isize;
        self.rp[u] = -1;
    }
    fn put(&mut self, u: usize, x: usize) {
        self.detach(u);
        if self.size[x] > self.cap {
            return;
        }
        if !self.cached[x] {
            self.used += self.size[x]
        }
        self.touch(x);
        self.attach(u, x);
        while self.used > self.cap {
            let dead = self.head as usize;
            self.lr(dead);
            self.cached[dead] = false;
            self.used -= self.size[dead];
            let mut v = self.rh[dead];
            while v >= 0 {
                let z = self.rn[v as usize];
                self.node[v as usize] = -1;
                self.rp[v as usize] = -1;
                self.rn[v as usize] = -1;
                v = z
            }
            self.rh[dead] = -1;
        }
    }
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let d: usize = it.next().unwrap().parse().unwrap();
    let q: usize = it.next().unwrap().parse().unwrap();
    let cap: u64 = it.next().unwrap().parse().unwrap();
    let size = (0..d)
        .map(|_| it.next().unwrap().parse().unwrap())
        .collect();
    let mut c = Cache {
        cap,
        size,
        used: 0,
        cached: vec![false; d],
        lp: vec![-1; d],
        ln: vec![-1; d],
        rh: vec![-1; d],
        node: vec![-1; n],
        rp: vec![-1; n],
        rn: vec![-1; n],
        head: -1,
        tail: -1,
    };
    let mut out = String::new();
    for _ in 0..q {
        let op = it.next().unwrap();
        let u = it.next().unwrap().parse::<usize>().unwrap() - 1;
        if op == "P" {
            let x = it.next().unwrap().parse::<usize>().unwrap() - 1;
            c.put(u, x)
        } else if c.node[u] < 0 {
            out.push_str("MISS\n")
        } else {
            let x = c.node[u] as usize;
            c.touch(x);
            out.push_str(&format!("HIT {}\n", x + 1));
        }
    }
    print!("{out}");
}
