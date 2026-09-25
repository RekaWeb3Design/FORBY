// Cuts a 16 kHz mono stream into speech segments with a voice activity detector. Pure: no audio device, no Tauri.

pub const SAMPLE_RATE: usize = 16_000;
// Earshot works on 16 ms frames
pub const FRAME: usize = 256;

const fn ms_to_samples(ms: usize) -> usize {
    ms * SAMPLE_RATE / 1000
}

pub const fn samples_to_ms(samples: usize) -> usize {
    samples * 1000 / SAMPLE_RATE
}

// A frame starts speech at START_SCORE; once in speech, frames down to KEEP_SCORE still count as speech.
// Measured: steady white or brown noise peaks at 0.58-0.69 (mean 0.16-0.40), TTS speech stays above 0.7 for long runs.
const START_SCORE: f32 = 0.7;
const KEEP_SCORE: f32 = 0.5;
// Consecutive speech frames needed to open a segment (clicks and single blips never do)
const START_FRAMES: usize = 2;
// Audio kept from before the segment opened, so the first syllable is not lost
const PRE_ROLL: usize = ms_to_samples(500);
// Silence that closes a segment; shorter pauses (e.g. between "hey Forby" and the command) stay inside
const END_SILENCE: usize = ms_to_samples(600);
// Silence kept after the last speech frame
const POST_ROLL: usize = ms_to_samples(200);
// Segments with less speech than this (first to last speech frame) are dropped
const MIN_SPEECH: usize = ms_to_samples(500);
// Longer segments are cut here (pre-roll included); the rest of that speech is skipped
const MAX_SEGMENT: usize = ms_to_samples(6000);

pub trait Vad {
    // Voice probability of one FRAME-long frame, 0..1
    fn score(&mut self, frame: &[f32]) -> f32;
    fn reset(&mut self);
}

impl Vad for Box<earshot::Detector> {
    fn score(&mut self, frame: &[f32]) -> f32 {
        // predict_f32 expects [-1, 1]; resampling can overshoot slightly
        let mut clamped = [0.0f32; FRAME];
        for (c, s) in clamped.iter_mut().zip(frame) {
            *c = s.clamp(-1.0, 1.0);
        }
        self.predict_f32(&clamped)
    }

    fn reset(&mut self) {
        earshot::Detector::reset(self);
    }
}

pub struct Segment {
    pub samples: Vec<f32>,
    pub truncated: bool,
}

impl Segment {
    pub fn ms(&self) -> usize {
        samples_to_ms(self.samples.len())
    }
}

enum State {
    Idle { speech_run: usize },
    // speech_start / last_speech_end are sample offsets inside `audio`
    Speech { audio: Vec<f32>, speech_start: usize, last_speech_end: usize },
    // A segment was cut at MAX_SEGMENT; wait for the speech to end before listening again
    Draining,
}

pub struct Segmenter<V: Vad> {
    vad: V,
    frame: Vec<f32>,
    // The last PRE_ROLL + START_FRAMES frames while idle
    ring: std::collections::VecDeque<f32>,
    silence: usize,
    state: State,
}

impl<V: Vad> Segmenter<V> {
    pub fn new(vad: V) -> Self {
        Self {
            vad,
            frame: Vec::with_capacity(FRAME),
            ring: std::collections::VecDeque::with_capacity(PRE_ROLL + START_FRAMES * FRAME),
            silence: 0,
            state: State::Idle { speech_run: 0 },
        }
    }

    // For a new stream (e.g. after the input device was reopened)
    pub fn reset(&mut self) {
        self.vad.reset();
        self.frame.clear();
        self.ring.clear();
        self.silence = 0;
        self.state = State::Idle { speech_run: 0 };
    }

    pub fn push(&mut self, samples: &[f32], on_segment: &mut impl FnMut(Segment)) {
        for &s in samples {
            self.frame.push(s);
            if self.frame.len() == FRAME {
                let frame = std::mem::replace(&mut self.frame, Vec::with_capacity(FRAME));
                self.process_frame(&frame, on_segment);
            }
        }
    }

    fn process_frame(&mut self, frame: &[f32], on_segment: &mut impl FnMut(Segment)) {
        let score = self.vad.score(frame);
        match &mut self.state {
            State::Idle { speech_run } => {
                self.ring.extend(frame);
                let excess = self.ring.len().saturating_sub(PRE_ROLL + START_FRAMES * FRAME);
                self.ring.drain(..excess);
                *speech_run = if score >= START_SCORE { *speech_run + 1 } else { 0 };
                if *speech_run >= START_FRAMES {
                    let audio: Vec<f32> = self.ring.drain(..).collect();
                    let len = audio.len();
                    self.silence = 0;
                    self.state = State::Speech { audio, speech_start: len - START_FRAMES * FRAME, last_speech_end: len };
                }
            }
            State::Speech { audio, speech_start, last_speech_end } => {
                audio.extend_from_slice(frame);
                if score >= KEEP_SCORE {
                    *last_speech_end = audio.len();
                    self.silence = 0;
                } else {
                    self.silence += FRAME;
                }
                if audio.len() >= MAX_SEGMENT {
                    audio.truncate(MAX_SEGMENT);
                    let samples = std::mem::take(audio);
                    // Still speaking at the cut: skip the rest of it; if it had already gone quiet, listen again
                    self.state = if self.silence == 0 { State::Draining } else { State::Idle { speech_run: 0 } };
                    self.silence = 0;
                    on_segment(Segment { samples, truncated: true });
                } else if self.silence >= END_SILENCE {
                    let (start, end) = (*speech_start, *last_speech_end);
                    let mut samples = std::mem::take(audio);
                    self.state = State::Idle { speech_run: 0 };
                    self.silence = 0;
                    if end - start >= MIN_SPEECH {
                        samples.truncate(end + POST_ROLL);
                        on_segment(Segment { samples, truncated: false });
                    }
                }
            }
            State::Draining => {
                if score >= KEEP_SCORE {
                    self.silence = 0;
                } else {
                    self.silence += FRAME;
                    if self.silence >= END_SILENCE {
                        self.silence = 0;
                        self.state = State::Idle { speech_run: 0 };
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Deterministic stand-in for the VAD: loud frames are speech
    struct LoudnessVad;
    impl Vad for LoudnessVad {
        fn score(&mut self, frame: &[f32]) -> f32 {
            let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
            if rms > 0.05 { 1.0 } else { 0.0 }
        }
        fn reset(&mut self) {}
    }

    fn tone(ms: usize) -> Vec<f32> {
        (0..ms_to_samples(ms)).map(|i| 0.5 * (i as f32 * 2.0 * std::f32::consts::PI * 220.0 / SAMPLE_RATE as f32).sin()).collect()
    }

    fn silence(ms: usize) -> Vec<f32> {
        vec![0.0; ms_to_samples(ms)]
    }

    // Deterministic white noise (LCG), amplitude `amp`
    fn noise(ms: usize, amp: f32) -> Vec<f32> {
        let mut x: u32 = 12345;
        (0..ms_to_samples(ms))
            .map(|_| {
                x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((x >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0) * amp
            })
            .collect()
    }

    fn run<V: Vad>(vad: V, parts: &[Vec<f32>]) -> Vec<Segment> {
        let mut seg = Segmenter::new(vad);
        let mut out = Vec::new();
        // Uneven chunks, like a capture callback
        for chunk in parts.concat().chunks(333) {
            seg.push(chunk, &mut |s| out.push(s));
        }
        out
    }

    #[test]
    fn short_speech_is_dropped() {
        assert!(run(LoudnessVad, &[silence(1000), tone(300), silence(1000)]).is_empty());
    }

    #[test]
    fn segment_keeps_pre_roll_and_post_roll() {
        let out = run(LoudnessVad, &[silence(1000), tone(1500), silence(1000)]);
        assert_eq!(out.len(), 1);
        assert!(!out[0].truncated);
        // 500 ms pre-roll + 1500 ms speech + 200 ms post-roll, give or take a frame
        let ms = out[0].ms();
        assert!((2180..=2230).contains(&ms), "{ms} ms");
        // The pre-roll is the silence before the speech
        assert!(out[0].samples[..ms_to_samples(400)].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn short_pause_stays_in_one_segment() {
        let out = run(LoudnessVad, &[silence(1000), tone(800), silence(300), tone(800), silence(1000)]);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn long_pause_splits_segments() {
        let out = run(LoudnessVad, &[silence(1000), tone(1000), silence(1000), tone(1000), silence(1000)]);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn long_speech_is_cut_at_six_seconds_once() {
        let out = run(LoudnessVad, &[silence(1000), tone(9000), silence(1000), tone(1000), silence(1000)]);
        assert_eq!(out.len(), 2, "the cut segment, then the next utterance; not the rest of the long one");
        assert!(out[0].truncated);
        assert_eq!(out[0].samples.len(), MAX_SEGMENT);
        assert!(!out[1].truncated);
    }

    #[test]
    fn earshot_ignores_silence_and_noise() {
        assert!(run(earshot::Detector::default_boxed(), &[silence(3000)]).is_empty());
        assert!(run(earshot::Detector::default_boxed(), &[noise(3000, 0.05)]).is_empty());
    }

    // Manual check on real speech: VOICE_TEST_WAV=<16 kHz mono 16-bit WAV> cargo test voice -- --ignored --nocapture
    #[test]
    #[ignore]
    fn earshot_finds_speech_in_wav() {
        let path = std::env::var("VOICE_TEST_WAV").expect("set VOICE_TEST_WAV");
        let bytes = std::fs::read(&path).expect("read wav");
        let data = bytes.windows(4).position(|w| w == b"data").expect("data chunk") + 8;
        let speech: Vec<f32> = bytes[data..].as_chunks::<2>().0.iter().map(|&b| i16::from_le_bytes(b) as f32 / 32768.0).collect();
        let out = run(earshot::Detector::default_boxed(), &[silence(1000), speech, silence(1500)]);
        for s in &out {
            println!("segment {} ms, truncated {}", s.ms(), s.truncated);
        }
        assert!(!out.is_empty());
    }
}
