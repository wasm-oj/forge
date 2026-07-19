use std::collections::VecDeque;
use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let m: usize = it.next().unwrap().parse().unwrap();
    let c: usize = it.next().unwrap().parse().unwrap();
    let mut g = vec![vec![]; n];
    for _ in 0..m {
        let u: usize = it.next().unwrap().parse::<usize>().unwrap() - 1;
        let v: usize = it.next().unwrap().parse::<usize>().unwrap() - 1;
        g[u].push(v);
    }
    let mut d = vec![false; n];
    let mut q = VecDeque::new();
    for _ in 0..c {
        let x = it.next().unwrap().parse::<usize>().unwrap() - 1;
        if !d[x] {
            d[x] = true;
            q.push_back(x)
        }
    }
    while let Some(u) = q.pop_front() {
        for &v in &g[u] {
            if !d[v] {
                d[v] = true;
                q.push_back(v)
            }
        }
    }
    println!("{}", d.iter().filter(|&&x| x).count());
    let ans = d
        .iter()
        .enumerate()
        .filter(|x| *x.1)
        .map(|x| (x.0 + 1).to_string())
        .collect::<Vec<_>>();
    println!("{}", ans.join(" "));
}
