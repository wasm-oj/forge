use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let n: usize = t.next().unwrap().parse().unwrap();
    let mut h = BinaryHeap::<Reverse<(u64, usize)>>::new();
    let mut active = vec![false; n + 1];
    let mut clock = 0u64;
    let mut out = String::new();
    for _ in 0..n {
        match t.next().unwrap() {
            "T" => {
                let id: usize = t.next().unwrap().parse().unwrap();
                let d: u64 = t.next().unwrap().parse().unwrap();
                active[id] = true;
                h.push(Reverse((d, id)));
            }
            "C" => {
                let id: usize = t.next().unwrap().parse().unwrap();
                active[id] = false;
            }
            _ => {
                let ready: u64 = t.next().unwrap().parse().unwrap();
                while let Some(Reverse((_, id))) = h.peek() {
                    if active[*id] {
                        break;
                    }
                    h.pop();
                }
                if ready == 0 {
                    if let Some(Reverse((d, _))) = h.peek() {
                        clock = clock.max(*d);
                    }
                }
                let mut f = Vec::new();
                while let Some(Reverse((d, id))) = h.peek().copied() {
                    if d > clock {
                        break;
                    }
                    h.pop();
                    if active[id] {
                        active[id] = false;
                        f.push(id);
                    }
                }
                out += &format!("{} {} {}", clock, ready, f.len());
                for id in f {
                    out += &format!(" {}", id);
                }
                out.push('\n');
            }
        }
    }
    print!("{}", out);
}
