use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let n: usize = t.next().unwrap().parse().unwrap();
    let r: usize = t.next().unwrap().parse().unwrap();
    let mut a = Vec::new();
    for _ in 0..n {
        a.push((
            t.next().unwrap(),
            t.next().unwrap().parse::<i64>().unwrap(),
            t.next().unwrap().parse::<i64>().unwrap(),
        ))
    }
    let q: Vec<&str> = (0..r).map(|_| t.next().unwrap()).collect();
    for i in 1..n {
        if a[i].0 <= a[i - 1].0 {
            println!("INVALID BLOB_ORDER {}", i + 1);
            return;
        }
    }
    for (i, x) in a.iter().enumerate() {
        if x.1 != x.2 {
            println!("INVALID LENGTH {}", i + 1);
            return;
        }
    }
    for i in 1..r {
        if q[i] <= q[i - 1] {
            println!("INVALID REF_ORDER {}", i + 1);
            return;
        }
    }
    let mut j = 0;
    for (i, d) in q.iter().enumerate() {
        while j < n && a[j].0 < *d {
            j += 1
        }
        if j == n || a[j].0 != *d {
            println!("INVALID MISSING {}", i + 1);
            return;
        }
        j += 1
    }
    j = 0;
    let mut total = 0i64;
    for d in &q {
        while a[j].0 < *d {
            j += 1
        }
        total += a[j].2;
        j += 1
    }
    println!("VALID {total}")
}
