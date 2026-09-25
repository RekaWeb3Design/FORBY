// Dev builds only (the module is compiled out of release): each segment as a WAV in <app data>/voice-debug,
// keeping the newest KEEP files. Paths never go to the log.
use std::path::Path;

use super::segmenter::SAMPLE_RATE;

const DIR: &str = "voice-debug";
const KEEP: usize = 20;

pub fn save(app_data: &Path, samples: &[f32]) -> Result<(), String> {
    let dir = app_data.join(DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    // Zero-padded so the names sort by time
    std::fs::write(dir.join(format!("segment-{millis:015}.wav")), wav_bytes(samples)).map_err(|e| e.to_string())?;
    prune(&dir)
}

fn prune(dir: &Path) -> Result<(), String> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "wav"))
        .collect();
    files.sort();
    for old in &files[..files.len().saturating_sub(KEEP)] {
        std::fs::remove_file(old).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 16 kHz mono 16-bit PCM
fn wav_bytes(samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let rate = SAMPLE_RATE as u32;
    let mut b = Vec::with_capacity(44 + data_len as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        b.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_newest_files() {
        let dir = std::env::temp_dir().join(format!("forby-voice-debug-test-{}", std::process::id()));
        for i in 0..25 {
            std::fs::create_dir_all(dir.join(DIR)).unwrap();
            std::fs::write(dir.join(DIR).join(format!("segment-{i:015}.wav")), b"x").unwrap();
        }
        save(&dir, &[0.0; 160]).unwrap();
        let mut names: Vec<_> = std::fs::read_dir(dir.join(DIR)).unwrap().map(|e| e.unwrap().file_name()).collect();
        names.sort();
        assert_eq!(names.len(), KEEP);
        // The oldest six are gone, the new one (a real timestamp, so the largest name) is kept
        assert_eq!(names[0].to_str().unwrap(), "segment-000000000000006.wav");
        assert_eq!(std::fs::metadata(dir.join(DIR).join(names.last().unwrap())).unwrap().len(), 44 + 320);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
