use std::collections::HashMap;
use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let mut tokens = input.split_whitespace();
    let n: usize = tokens.next().unwrap().parse().unwrap();
    let mut first_index: HashMap<&str, usize> = HashMap::with_capacity(n * 2);

    for index in 1..=n {
        let fingerprint = tokens.next().unwrap();
        if let Some(&earliest) = first_index.get(fingerprint) {
            println!("{} {}", index, earliest);
            return;
        }
        first_index.insert(fingerprint, index);
    }
    println!("NONE");
}
