use std::io::{self, BufWriter, Read, Write};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let q: usize = it.next().unwrap().parse().unwrap();
    let mut f = Vec::with_capacity(n);
    for _ in 0..n {
        f.push((
            it.next().unwrap().to_string(),
            it.next().unwrap().to_string(),
        ));
    }
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    for _ in 0..q {
        let meta: [&str; 4] = std::array::from_fn(|_| it.next().unwrap());
        let k: usize = it.next().unwrap().parse().unwrap();
        let mut ids: Vec<usize> = (0..k)
            .map(|_| it.next().unwrap().parse::<usize>().unwrap() - 1)
            .collect();
        ids.sort_by(|&a, &b| f[a].0.cmp(&f[b].0));
        write!(out, "{} {} {} {} {}", meta[0], meta[1], meta[2], meta[3], k).unwrap();
        for x in ids {
            write!(out, " {} {}", f[x].0, f[x].1).unwrap();
        }
        writeln!(out).unwrap();
    }
}
