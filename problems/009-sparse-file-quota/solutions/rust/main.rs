use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let f: usize = t.next().unwrap().parse().unwrap();
    let n: usize = t.next().unwrap().parse().unwrap();
    let cap: u64 = t.next().unwrap().parse().unwrap();
    let mut size = vec![0u64; f + 1];
    let mut cur = vec![0u64; f + 1];
    let (mut used, mut peak) = (0u64, 0u64);
    let mut out = String::new();
    for _ in 0..n {
        let op = t.next().unwrap();
        let x: usize = t.next().unwrap().parse().unwrap();
        let v: u64 = t.next().unwrap().parse().unwrap();
        let mut err = false;
        if op == "SEEK" {
            cur[x] = v
        } else {
            let ns = if op == "WRITE" {
                if v == 0 {
                    size[x]
                } else {
                    size[x].max(cur[x] + v)
                }
            } else {
                v
            };
            if ns > size[x] && ns - size[x] > cap - used {
                err = true
            } else {
                if ns >= size[x] {
                    used += ns - size[x]
                } else {
                    used -= size[x] - ns
                }
                size[x] = ns;
                if op == "WRITE" && v > 0 {
                    cur[x] += v
                }
            }
        }
        peak = peak.max(used);
        out += &format!(
            "{} {} {} {}\n",
            if err { "ERR QUOTA" } else { "OK" },
            size[x],
            cur[x],
            used
        );
    }
    out += &format!("SUMMARY {} {}\n", used, peak);
    print!("{}", out);
}
