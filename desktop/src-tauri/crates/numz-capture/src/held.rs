//! The captures the native layer is holding for the page: in memory only, a few at a time, each forgotten after a few minutes.
//! A capture is never written to disk.

use crate::{CaptureError, RgbaImage};
use std::collections::HashMap;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const MAX_HELD: usize = 2;
pub const HOLD_FOR: Duration = Duration::from_secs(5 * 60);

pub struct Held {
    items: HashMap<String, (Instant, Arc<RgbaImage>)>,
    ttl: Duration,
    max: usize,
}

impl Default for Held {
    fn default() -> Self {
        Self::new(HOLD_FOR, MAX_HELD)
    }
}

fn random_id() -> String {
    // RandomState is seeded from the operating system, so this is unpredictable without another dependency.
    let state = RandomState::new();
    let mut a = state.build_hasher();
    a.write_u8(1);
    let mut b = state.build_hasher();
    b.write_u8(2);
    format!("cap-{:016x}{:016x}", a.finish(), b.finish())
}

impl Held {
    pub fn new(ttl: Duration, max: usize) -> Self {
        Self { items: HashMap::new(), ttl, max: max.max(1) }
    }

    fn sweep(&mut self, now: Instant) {
        let ttl = self.ttl;
        self.items.retain(|_, (taken, _)| now.duration_since(*taken) < ttl);
    }

    /// Holds a capture and returns its id. When too many are held the oldest goes first.
    pub fn insert(&mut self, image: RgbaImage) -> String {
        self.insert_at(image, Instant::now())
    }

    pub fn insert_at(&mut self, image: RgbaImage, now: Instant) -> String {
        self.sweep(now);
        while self.items.len() >= self.max {
            if let Some(oldest) = self.items.iter().min_by_key(|(_, (taken, _))| *taken).map(|(id, _)| id.clone()) {
                self.items.remove(&oldest);
            }
        }
        let id = random_id();
        self.items.insert(id.clone(), (now, Arc::new(image)));
        id
    }

    pub fn get(&mut self, id: &str) -> Result<Arc<RgbaImage>, CaptureError> {
        self.get_at(id, Instant::now())
    }

    pub fn get_at(&mut self, id: &str, now: Instant) -> Result<Arc<RgbaImage>, CaptureError> {
        self.sweep(now);
        self.items.get(id).map(|(_, image)| image.clone()).ok_or(CaptureError::Expired)
    }

    pub fn discard(&mut self, id: &str) {
        self.items.remove(id);
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny() -> RgbaImage {
        RgbaImage::new(2, 2)
    }

    #[test]
    fn a_capture_is_held_then_forgotten_after_its_time() {
        let mut held = Held::new(Duration::from_secs(60), 2);
        let t0 = Instant::now();
        let id = held.insert_at(tiny(), t0);
        assert!(id.starts_with("cap-") && id.len() > 30);
        assert!(held.get_at(&id, t0 + Duration::from_secs(59)).is_ok());
        assert_eq!(held.get_at(&id, t0 + Duration::from_secs(61)).unwrap_err().code(), "expired");
        assert!(held.is_empty(), "an expired capture is dropped, not just hidden");
    }

    #[test]
    fn only_a_few_are_held_and_the_oldest_goes_first() {
        let mut held = Held::new(Duration::from_secs(600), 2);
        let t0 = Instant::now();
        let a = held.insert_at(tiny(), t0);
        let b = held.insert_at(tiny(), t0 + Duration::from_secs(1));
        let c = held.insert_at(tiny(), t0 + Duration::from_secs(2));
        assert_eq!(held.len(), 2);
        assert!(held.get_at(&a, t0 + Duration::from_secs(3)).is_err());
        assert!(held.get_at(&b, t0 + Duration::from_secs(3)).is_ok());
        assert!(held.get_at(&c, t0 + Duration::from_secs(3)).is_ok());
    }

    #[test]
    fn discard_forgets_at_once_and_ids_differ() {
        let mut held = Held::default();
        let a = held.insert(tiny());
        let b = held.insert(tiny());
        assert_ne!(a, b);
        held.discard(&a);
        assert!(held.get(&a).is_err());
        assert!(held.get(&b).is_ok());
        held.discard("not-an-id");
    }
}
