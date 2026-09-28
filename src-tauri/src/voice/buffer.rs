// Live mode: the last few speech segments kept in memory under an id, so the text side can transcribe the same audio
// in both rounds. Old segments drop out on their own; the text side releases a segment when its chain is done.
use std::collections::VecDeque;
use std::sync::Arc;

use super::segmenter::SAMPLE_RATE;

pub const MAX_SEGMENTS: usize = 3;
// Segments are at most 6 s long, so this is only a safety net
pub const MAX_SAMPLES: usize = 30 * SAMPLE_RATE;

pub struct SegmentBuffer {
    next_id: u64,
    items: VecDeque<(u64, Arc<Vec<f32>>)>,
}

impl Default for SegmentBuffer {
    fn default() -> Self {
        Self { next_id: 1, items: VecDeque::new() }
    }
}

impl SegmentBuffer {
    // Stores a segment and returns its id; the oldest ones go beyond MAX_SEGMENTS / MAX_SAMPLES (the newest stays)
    pub fn push(&mut self, samples: Vec<f32>) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.items.push_back((id, Arc::new(samples)));
        while self.items.len() > MAX_SEGMENTS || (self.items.len() > 1 && self.total() > MAX_SAMPLES) {
            self.items.pop_front();
        }
        id
    }

    pub fn get(&self, id: u64) -> Option<Arc<Vec<f32>>> {
        self.items.iter().find(|(i, _)| *i == id).map(|(_, s)| s.clone())
    }

    // false if the id is unknown (never stored, already released or dropped)
    pub fn release(&mut self, id: u64) -> bool {
        let before = self.items.len();
        self.items.retain(|(i, _)| *i != id);
        self.items.len() != before
    }

    fn total(&self) -> usize {
        self.items.iter().map(|(_, s)| s.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_new_and_the_oldest_drops_out() {
        let mut b = SegmentBuffer::default();
        let ids: Vec<u64> = (0..4).map(|_| b.push(vec![0.0; 10])).collect();
        assert_eq!(ids, [1, 2, 3, 4]);
        assert!(b.get(1).is_none(), "the fourth push drops the first");
        assert!(ids[1..].iter().all(|&id| b.get(id).is_some()));
        assert_eq!(b.get(4).unwrap().len(), 10);
    }

    #[test]
    fn release_and_unknown_ids() {
        let mut b = SegmentBuffer::default();
        let id = b.push(vec![0.0; 10]);
        assert!(b.release(id));
        assert!(b.get(id).is_none());
        assert!(!b.release(id), "twice");
        assert!(!b.release(99));
        assert!(b.get(0).is_none());
        // Ids are not reused after a release
        assert_eq!(b.push(vec![]), id + 1);
    }

    #[test]
    fn total_length_is_capped_but_the_newest_stays() {
        let mut b = SegmentBuffer::default();
        let first = b.push(vec![0.0; MAX_SAMPLES / 2]);
        let second = b.push(vec![0.0; MAX_SAMPLES / 2]);
        assert!(b.get(first).is_some() && b.get(second).is_some());
        let third = b.push(vec![0.0; 10]);
        assert!(b.get(first).is_none());
        assert!(b.get(second).is_some() && b.get(third).is_some());
        let huge = b.push(vec![0.0; MAX_SAMPLES + 1]);
        assert!(b.get(huge).is_some());
        assert!(b.get(second).is_none() && b.get(third).is_none());
    }
}
