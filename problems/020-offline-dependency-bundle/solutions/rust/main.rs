use std::io::{self, Read};
fn pos(a: &[(String, u64)], d: &str) -> Result<usize, usize> {
    a.binary_search_by(|x| x.0.as_str().cmp(d))
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let m: usize = it.next().unwrap().parse().unwrap();
    let mut l = vec![];
    let mut total = 0u64;
    for _ in 0..n {
        it.next();
        let d = it.next().unwrap().to_string();
        let z = it.next().unwrap().parse().unwrap();
        total += z;
        l.push((d, z));
    }
    let mut p: Vec<(String, u64)> = (0..m)
        .map(|_| {
            (
                it.next().unwrap().to_string(),
                it.next().unwrap().parse().unwrap(),
            )
        })
        .collect();
    l.sort();
    p.sort();
    let mut req = vec![];
    let mut i = 0;
    while i < n {
        let mut j = i + 1;
        while j < n && l[j].0 == l[i].0 {
            if l[j].1 != l[i].1 {
                println!("LOCK_CONFLICT {}", l[i].0);
                return;
            }
            j += 1
        }
        req.push(l[i].clone());
        i = j
    }
    for i in 1..m {
        if p[i].0 == p[i - 1].0 {
            println!("DUPLICATE_PAYLOAD {}", p[i].0);
            return;
        }
    }
    for x in &req {
        if pos(&p, &x.0).is_err() {
            println!("MISSING {}", x.0);
            return;
        }
    }
    for x in &p {
        if pos(&req, &x.0).is_err() {
            println!("EXTRA {}", x.0);
            return;
        }
    }
    let mut unique = 0;
    for x in &req {
        let y = &p[pos(&p, &x.0).unwrap()];
        if x.1 != y.1 {
            println!("SIZE {}", x.0);
            return;
        }
        unique += x.1
    }
    println!("VALID {} {} {}", req.len(), unique, total - unique);
}
