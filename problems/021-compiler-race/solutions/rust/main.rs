use std::collections::HashMap;
use std::io::{self, Read};
struct Job {
    key: String,
    epoch: i32,
    kind: u8,
    alive: bool,
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let mut by: HashMap<String, usize> = HashMap::new();
    let mut a = vec![Job {
        key: String::new(),
        epoch: 0,
        kind: 0,
        alive: false,
    }];
    let (mut ep, mut bg) = (0, 0);
    let mut out = String::new();
    for _ in 0..n {
        let t = it.next().unwrap().as_bytes()[0];
        if t == b'B' || t == b'F' {
            let k = it.next().unwrap();
            let id = *by.get(k).unwrap_or(&0);
            let live = id > 0 && a[id].alive && (a[id].kind == b'F' || a[id].epoch == ep);
            if live {
                out += &format!("JOIN {id}\n")
            } else {
                let id = a.len();
                a.push(Job {
                    key: k.to_string(),
                    epoch: ep,
                    kind: t,
                    alive: true,
                });
                by.insert(k.to_string(), id);
                if t == b'B' {
                    bg += 1
                }
                out += &format!("NEW {id}\n")
            }
        } else if t == b'S' {
            out += &format!("CANCEL {bg}\n");
            bg = 0;
            ep += 1
        } else {
            let id: usize = it.next().unwrap().parse().unwrap();
            let live = id < a.len() && a[id].alive && (a[id].kind == b'F' || a[id].epoch == ep);
            if !live {
                out += "STALE\n"
            } else {
                a[id].alive = false;
                if a[id].kind == b'B' {
                    bg -= 1
                }
                if by.get(&a[id].key) == Some(&id) {
                    by.remove(&a[id].key);
                }
                out += "DONE\n"
            }
        }
    }
    print!("{out}")
}
