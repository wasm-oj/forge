use std::collections::HashMap;
use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let mut tokens = input.split_whitespace();
    let n: usize = tokens.next().unwrap().parse().unwrap();
    let k: usize = tokens.next().unwrap().parse().unwrap();
    let mut last_index: HashMap<&str, usize> = HashMap::with_capacity(n * 2);
    let mut hits = 0usize;

    for index in 1..=n {
        let fingerprint = tokens.next().unwrap();
        if let Some(&previous) = last_index.get(fingerprint) {
            if index - previous <= k {
                hits += 1;
            }
        }
        last_index.insert(fingerprint, index);
    }
    println!("{}", hits);
}
