use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let p: usize = t.next().unwrap().parse().unwrap();
    let n: usize = t.next().unwrap().parse().unwrap();
    let cap: u64 = t.next().unwrap().parse().unwrap();
    let limit: usize = t.next().unwrap().parse().unwrap();
    let mut ex = vec![false; p + 1];
    let mut sz = vec![0u64; p + 1];
    let (mut used, mut peakb, mut ino, mut peaki, mut sticky) = (0u64, 0u64, 0usize, 0usize, 0);
    let mut out = String::new();
    for _ in 0..n {
        let op = t.next().unwrap();
        let x: usize = t.next().unwrap().parse().unwrap();
        let mut err = "";
        if op == "CREATE" {
            if ex[x] {
                err = "EXISTS"
            } else if ino == limit {
                err = "INODES"
            } else {
                ex[x] = true;
                sz[x] = 0;
                ino += 1
            }
        } else if op == "UNLINK" {
            if !ex[x] {
                err = "NOENT"
            } else {
                used -= sz[x];
                sz[x] = 0;
                ex[x] = false;
                ino -= 1
            }
        } else {
            let v = if op == "WRITE" {
                let off: u64 = t.next().unwrap().parse().unwrap();
                let len: u64 = t.next().unwrap().parse().unwrap();
                if len == 0 {
                    sz[x]
                } else {
                    sz[x].max(off + len)
                }
            } else {
                t.next().unwrap().parse().unwrap()
            };
            if !ex[x] {
                err = "NOENT"
            } else if v > sz[x] && v - sz[x] > cap - used {
                err = "BYTES"
            } else {
                if v >= sz[x] {
                    used += v - sz[x]
                } else {
                    used -= sz[x] - v
                }
                sz[x] = v
            }
        }
        if err.is_empty() {
            out += "OK\n"
        } else {
            out += &format!("ERR {}\n", err);
            if err == "BYTES" || err == "INODES" {
                sticky = 1
            }
        }
        peakb = peakb.max(used);
        peaki = peaki.max(ino);
    }
    out += &format!("SUMMARY {} {} {} {} {}\n", used, ino, peakb, peaki, sticky);
    print!("{}", out);
}
