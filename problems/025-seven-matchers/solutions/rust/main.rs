use std::io::{self, Read};
fn radix_sort(values: Vec<String>) -> Vec<String> {
    let mut order: Vec<usize> = (0..values.len()).collect();
    let mut scratch = vec![0; values.len()];
    for position in (0..30).rev() {
        let mut next = [0usize; 257];
        for &index in &order {
            let key = values[index]
                .as_bytes()
                .get(position)
                .map_or(0, |byte| *byte as usize + 1);
            next[key] += 1;
        }
        let mut offset = 0;
        for entry in &mut next {
            let count = *entry;
            *entry = offset;
            offset += count;
        }
        for &index in &order {
            let key = values[index]
                .as_bytes()
                .get(position)
                .map_or(0, |byte| *byte as usize + 1);
            scratch[next[key]] = index;
            next[key] += 1;
        }
        std::mem::swap(&mut order, &mut scratch);
    }
    let mut slots: Vec<Option<String>> = values.into_iter().map(Some).collect();
    order
        .into_iter()
        .map(|index| slots[index].take().unwrap())
        .collect()
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let q: usize = t.next().unwrap().parse().unwrap();
    let mut out = String::new();
    for _ in 0..q {
        let k = t.next().unwrap();
        let n: usize = t.next().unwrap().parse().unwrap();
        let m: usize = t.next().unwrap().parse().unwrap();
        let eps: i128 = if k == "FLOAT" {
            t.next().unwrap().parse().unwrap()
        } else {
            0
        };
        let mut a: Vec<String> = (0..n).map(|_| t.next().unwrap().to_string()).collect();
        let mut b: Vec<String> = (0..m).map(|_| t.next().unwrap().to_string()).collect();
        let ok = if k == "EXACT" {
            a.concat() == b.concat()
        } else if k == "LINES" {
            while a.last().is_some_and(|x| x == "#") {
                a.pop();
            }
            while b.last().is_some_and(|x| x == "#") {
                b.pop();
            }
            a == b
        } else if k == "TOKENS" {
            a == b
        } else if k == "FLOAT" {
            n == m
                && a.iter().zip(&b).all(|(x, y)| {
                    (x.parse::<i128>().unwrap() - y.parse::<i128>().unwrap()).abs() <= eps
                })
        } else {
            a = radix_sort(a);
            b = radix_sort(b);
            if k == "SET" {
                a.dedup();
                b.dedup();
            }
            a == b
        };
        out += if ok { "ACCEPT\n" } else { "WRONG\n" }
    }
    print!("{out}")
}
