use std::fmt::Write;
use std::io::{self, Read};
fn ascii(out: &mut String, s: &str) {
    for b in s.bytes() {
        write!(out, "{b:02x}").unwrap();
    }
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let mut a: Vec<(u8, &str, &str)> = (0..n)
        .map(|_| {
            (
                it.next().unwrap().as_bytes()[0],
                it.next().unwrap(),
                it.next().unwrap(),
            )
        })
        .collect();
    a.sort_by_key(|x| x.1);
    let mut out = format!("574f424a{n:08x}");
    for (t, p, v) in a {
        let z = if v == "-" {
            0
        } else if t == b'T' {
            v.len()
        } else {
            v.len() / 2
        };
        out.push_str(if t == b'T' { "01" } else { "02" });
        write!(out, "{:08x}", p.len()).unwrap();
        ascii(&mut out, p);
        write!(out, "{z:016x}").unwrap();
        if z > 0 {
            if t == b'T' {
                ascii(&mut out, v)
            } else {
                out.push_str(v)
            }
        }
    }
    println!("{out}");
}
