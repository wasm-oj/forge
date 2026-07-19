use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut l = s.lines();
    let h = l.next().unwrap().split_whitespace().collect::<Vec<_>>();
    let n: usize = h[0].parse().unwrap();
    let e = h[1];
    let mut a = Vec::new();
    for line in l.take(n) {
        let p = line.split_whitespace().nth(1).unwrap();
        if p == e || p.strip_prefix(e).is_some_and(|x| x.starts_with('/')) {
            continue;
        }
        a.push((p, line))
    }
    a.sort_by_key(|x| x.0);
    println!("{}", a.len());
    for x in a {
        println!("{}", x.1)
    }
}
