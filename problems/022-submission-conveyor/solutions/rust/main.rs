use std::{
    collections::{HashMap, VecDeque},
    io::{self, Read},
};
fn main() {
    let mut z = String::new();
    io::stdin().read_to_string(&mut z).unwrap();
    let mut it = z.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let (mut active, mut waiting) = (0i32, 0i32);
    let mut q = VecDeque::new();
    let mut s: HashMap<i32, u8> = HashMap::new();
    let mut out = String::new();
    for _ in 0..n {
        let t = it.next().unwrap();
        if t == "A" {
            let x = it.next().unwrap().parse().unwrap();
            if active == 0 {
                active = x;
                s.insert(x, 2);
            } else {
                s.insert(x, 1);
                q.push_back(x);
                waiting += 1;
            }
        } else if t == "C" {
            let x = it.next().unwrap().parse().unwrap();
            match s.get(&x).copied() {
                Some(1) => {
                    s.insert(x, 3);
                    waiting -= 1
                }
                Some(2) => {
                    s.insert(x, 3);
                    active = 0
                }
                _ => {}
            }
        } else if active != 0 {
            s.insert(active, 3);
            active = 0
        }
        while active == 0 {
            if let Some(x) = q.pop_front() {
                if s.get(&x) == Some(&1) {
                    s.insert(x, 2);
                    active = x;
                    waiting -= 1;
                    break;
                }
            } else {
                break;
            }
        }
        out += &format!("{active} {waiting}\n")
    }
    print!("{out}")
}
