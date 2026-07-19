use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::io::{self, Read};
fn find_id(names: &[String], order: &[usize], key: &str) -> Option<usize> {
    order
        .binary_search_by(|&index| names[index].as_str().cmp(key))
        .ok()
        .map(|position| order[position])
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let m: usize = it.next().unwrap().parse().unwrap();
    let names: Vec<String> = (0..n).map(|_| it.next().unwrap().to_string()).collect();
    let mut name_order: Vec<usize> = (0..n).collect();
    name_order.sort_by(|&x, &y| names[x].cmp(&names[y]));
    let mut g = vec![vec![]; n];
    let mut deg = vec![0; n];
    let mut bad = 0;
    for i in 1..=m {
        let a = it.next().unwrap();
        let b = it.next().unwrap();
        if let (Some(x), Some(y)) = (
            find_id(&names, &name_order, a),
            find_id(&names, &name_order, b),
        ) {
            g[y].push(x);
            deg[x] += 1
        } else if bad == 0 {
            bad = i
        }
    }
    if bad > 0 {
        println!("INVALID DANGLING {bad}");
        return;
    }
    let mut h = BinaryHeap::new();
    for i in 0..n {
        if deg[i] == 0 {
            h.push(Reverse((names[i].clone(), i)))
        }
    }
    let mut out = vec![];
    while let Some(Reverse((name, u))) = h.pop() {
        out.push(name);
        for &v in &g[u] {
            deg[v] -= 1;
            if deg[v] == 0 {
                h.push(Reverse((names[v].clone(), v)))
            }
        }
    }
    if out.len() < n {
        println!("INVALID CYCLE")
    } else {
        println!("ORDER {}", out.join(" "))
    }
}
