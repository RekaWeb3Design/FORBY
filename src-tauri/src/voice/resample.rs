// Mono samples at the device rate to 16 kHz, in a stream of arbitrary chunk sizes
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};

use super::segmenter::SAMPLE_RATE;

const CHUNK: usize = 1024;

pub struct To16k {
    // None when the device already runs at 16 kHz
    fft: Option<Fft<f32>>,
    pending: Vec<f32>,
    out: Vec<f32>,
}

impl To16k {
    pub fn new(rate_in: u32) -> Result<Self, String> {
        if rate_in as usize == SAMPLE_RATE {
            return Ok(Self { fft: None, pending: Vec::new(), out: Vec::new() });
        }
        let fft = Fft::<f32>::new(rate_in as usize, SAMPLE_RATE, CHUNK, 1, FixedSync::Input).map_err(|e| e.to_string())?;
        let out = vec![0.0; fft.output_frames_max()];
        Ok(Self { fft: Some(fft), pending: Vec::with_capacity(CHUNK * 2), out })
    }

    // Calls `sink` with each run of resampled samples
    pub fn push(&mut self, samples: &[f32], sink: &mut impl FnMut(&[f32])) -> Result<(), String> {
        let Some(fft) = &mut self.fft else {
            sink(samples);
            return Ok(());
        };
        self.pending.extend_from_slice(samples);
        loop {
            let need = fft.input_frames_next();
            if self.pending.len() < need {
                return Ok(());
            }
            let capacity = self.out.len();
            let input = InterleavedSlice::new(&self.pending[..need], 1, need).map_err(|e| e.to_string())?;
            let mut output = InterleavedSlice::new_mut(&mut self.out, 1, capacity).map_err(|e| e.to_string())?;
            let (read, written) = fft.process_into_buffer(&input, &mut output, None).map_err(|e| e.to_string())?;
            sink(&self.out[..written]);
            self.pending.drain(..read);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_second_at_48k_gives_about_one_second_at_16k() {
        let mut r = To16k::new(48_000).unwrap();
        let input: Vec<f32> = (0..48_000).map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 440.0 / 48_000.0).sin() * 0.5).collect();
        let mut out = Vec::new();
        for chunk in input.chunks(480) {
            r.push(chunk, &mut |s| out.extend_from_slice(s)).unwrap();
        }
        // Up to one chunk stays buffered
        assert!((16_000 - 1024..=16_000).contains(&out.len()), "{} samples", out.len());
        // The tone survives: past the start-up delay the level stays near 0.5
        let peak = out[2000..].iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!((0.45..0.55).contains(&peak), "peak {peak}");
    }

    #[test]
    fn sixteen_k_passes_through() {
        let mut r = To16k::new(16_000).unwrap();
        let mut out = Vec::new();
        r.push(&[0.1, 0.2, 0.3], &mut |s| out.extend_from_slice(s)).unwrap();
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }
}
