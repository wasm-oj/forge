use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let mut tokens = input.split_whitespace();

    let mounted_count: usize = tokens.next().unwrap().parse().unwrap();
    let output_count: usize = tokens.next().unwrap().parse().unwrap();
    let byte_quota: u64 = tokens.next().unwrap().parse().unwrap();
    let inode_quota: u64 = tokens.next().unwrap().parse().unwrap();

    let path_count = mounted_count + output_count;
    let mut paths = Vec::<Vec<u32>>::with_capacity(path_count);
    let mut baseline_bytes = 0_u64;
    for i in 0..path_count {
        let length: usize = tokens.next().unwrap().parse().unwrap();
        let mut path = Vec::with_capacity(length);
        for _ in 0..length {
            path.push(tokens.next().unwrap().parse().unwrap());
        }
        paths.push(path);
        if i < mounted_count {
            baseline_bytes += tokens.next().unwrap().parse::<u64>().unwrap();
        }
    }

    paths.sort();
    let mut directory_count = 1_u64;
    for i in 0..path_count {
        let parent_length = paths[i].len() - 1;
        let already_present = if i == 0 {
            0
        } else {
            paths[i - 1]
                .iter()
                .zip(&paths[i])
                .take_while(|(a, b)| a == b)
                .count()
                .min(parent_length)
        };
        directory_count += (parent_length - already_present) as u64;
    }

    let baseline_inodes = directory_count + path_count as u64;
    if baseline_bytes <= byte_quota && baseline_inodes <= inode_quota {
        println!(
            "ACCEPT {} {} {} {}",
            baseline_bytes,
            baseline_inodes,
            byte_quota - baseline_bytes,
            inode_quota - baseline_inodes
        );
    } else {
        println!(
            "REJECT {} {} {} {}",
            baseline_bytes,
            baseline_inodes,
            baseline_bytes.saturating_sub(byte_quota),
            baseline_inodes.saturating_sub(inode_quota)
        );
    }
}
