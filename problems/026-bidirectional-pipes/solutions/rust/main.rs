use std::io::{self, Read};
#[derive(Clone, Copy)]
struct A {
    t: u8,
    k: i64,
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let c: i64 = it.next().unwrap().parse().unwrap();
    let n = [
        it.next().unwrap().parse::<usize>().unwrap(),
        it.next().unwrap().parse::<usize>().unwrap(),
    ];
    let mut a = [Vec::new(), Vec::new()];
    for w in 0..2 {
        for _ in 0..n[w] {
            let t = it.next().unwrap().as_bytes()[0];
            let k = if t == b'C' {
                0
            } else {
                it.next().unwrap().parse().unwrap()
            };
            a[w].push(A { t, k })
        }
    }
    let (mut pc, mut closed, mut occ, mut steps) =
        ([0usize; 2], [n[0] == 0, n[1] == 0], [0i64; 2], 0i64);
    loop {
        if pc == n {
            println!("SUCCESS {steps} {} {}", occ[0], occ[1]);
            break;
        }
        let mut progress = false;
        for w in 0..2 {
            if pc[w] == n[w] {
                continue;
            }
            let x = a[w][pc[w]];
            let o = 1 - w;
            let z = if x.t == b'W' {
                if c - occ[w] < x.k {
                    0
                } else {
                    occ[w] += x.k;
                    1
                }
            } else if x.t == b'R' {
                if occ[o] < x.k {
                    if closed[o] { -1 } else { 0 }
                } else {
                    occ[o] -= x.k;
                    1
                }
            } else {
                closed[w] = true;
                1
            };
            if z < 0 {
                println!(
                    "FAIL {} {steps} {} {}",
                    if w == 0 { "A" } else { "B" },
                    occ[0],
                    occ[1]
                );
                return;
            }
            if z == 1 {
                pc[w] += 1;
                steps += 1;
                progress = true;
                if pc[w] == n[w] {
                    closed[w] = true
                }
            }
        }
        if !progress {
            println!("DEADLOCK {steps} {} {}", occ[0], occ[1]);
            break;
        }
    }
}
