# Spikes

## voice-receive (Task 1)

Date: 2026-10-27.
Guild: throwaway test guild, channel `Meeting`, one speaker.
Command: `SPIKE_SECONDS=150 cargo run` with `.env.spike` (gitignored).

Versions from `Cargo.lock`: serenity 0.12.5, songbird 0.6.1, davey 0.1.5, opus2 0.4.0, tokio 1.54.1.

Output line: `user=246618919064961034 first_packet_ms=61220 samples=1892640 max_gap_ms=1539 plc_ticks=49 max_samples_per_tick=480`.

### Answers

- (a) serenity 0.12.5 and songbird 0.6.1 resolve and build together.
- (b) PASS. `DecodeMode::Decode(Mono, Hz24000)` delivered 24 kHz mono PCM for the speaker under DAVE.
  The file decodes to 87 s of speech at -32.5 dB RMS, and whisper large-v3 transcribed it as clear Thai speech.
  `max_samples_per_tick` stayed at 480, so no concealment frames entered the timeline.
  The longest gaps (up to 4.4 s by silencedetect, 1.5 s between packets) are pauses between sentences, not stalls.
- Caveat for (b): the first 50 packets (about 1 s) after the speaker started failed with `opus_decode InvalidPacket`, matching `plc_ticks=49`.
  Likely cause: packets arrived before the DAVE key was ready.
  `plan_write` writes nothing for them, so the first second of the first utterance is lost.
  Not yet compared with the Node bot.
- (c) NOT TESTED. Only one person was available, so the second-member join (songbird issue 310) was not exercised.

### Result

PARTIAL PASS: (a) and (b) pass, (c) pending a two-person run.
Task 9 must not start until (c) passes.
