//! Spike: verify songbird voice receive (transport + DAVE decrypt, Opus decode)
//! delivers 24 kHz mono i16 PCM per speaker, ahead of the full migration.
//!
//! Env: `SPIKE_DISCORD_TOKEN`, `SPIKE_GUILD_ID`, `SPIKE_VOICE_CHANNEL_ID`,
//! optional `SPIKE_SECONDS` (default 120).
//! Output: `spike-out/{userId}.pcm` (24 kHz mono s16le) and one stats line per
//! speaker: `user=<id> first_packet_ms=<n> samples=<n> max_gap_ms=<n> plc_ticks=<n> max_samples_per_tick=<n>`.

use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    os::unix::fs::FileExt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serenity::{
    async_trait,
    model::{
        gateway::{GatewayIntents, Ready},
        id::{ChannelId, GuildId},
    },
    prelude::Context,
};
use songbird::{
    Config,
    driver::{Channels, DecodeConfig, DecodeMode, SampleRate},
    events::{CoreEvent, Event, EventContext, EventHandler as SongbirdEventHandler},
};
use tokio::sync::Mutex;

use serenity::client::EventHandler as SerenityEventHandler;

/// Received audio is decoded to 24 kHz mono, i.e. 24 samples per millisecond.
const SAMPLES_PER_MS: u64 = 24;

// --- pure timeline logic (unit-tested below) ---

/// The pure per-speaker state the write decision depends on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WriteState {
    /// Next sample position to write at (24 kHz samples, not bytes).
    cursor: u64,
    /// Start time (ms) of the last written packet; `None` before the first.
    last_packet_ms: Option<u64>,
}

/// One planned write: where the payload lands and where the cursor ends up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WritePlan {
    /// Sample offset to write the payload at.
    write_at: u64,
    /// Cursor value after appending the payload.
    new_cursor: u64,
}

/// A silence longer than this (ms) ends an utterance; the next written
/// packet starts a new one and snaps the cursor to the wall clock.
const UTTERANCE_GAP_MS: u64 = 1000;

/// The single write decision for one VoiceTick entry.
///
/// Returns `None` when the tick carries no real RTP packet (songbird hands
/// out a concealment frame, `packet: None`) or no decoded samples, so a lost
/// or empty tick never touches the timeline. At an utterance start (the
/// first written packet, or more than `UTTERANCE_GAP_MS` since the last one)
/// the payload lands at `max(cursor, elapsed_ms * SAMPLES_PER_MS)` so
/// silence stays in the timeline, like `TrackWriter`; inside an utterance it
/// appends contiguously at the cursor.
fn plan_write(
    state: WriteState,
    packet_present: bool,
    pcm_len: usize,
    now_ms: u64,
) -> Option<WritePlan> {
    if !packet_present || pcm_len == 0 {
        return None;
    }
    let utterance_start = state
        .last_packet_ms
        .is_none_or(|prev| now_ms.saturating_sub(prev) > UTTERANCE_GAP_MS);
    let write_at = if utterance_start {
        state.cursor.max(now_ms * SAMPLES_PER_MS)
    } else {
        state.cursor
    };
    Some(WritePlan {
        write_at,
        new_cursor: write_at + pcm_len as u64,
    })
}

/// Update the running maximum gap (ms) between consecutive written packets
/// and the last-seen packet time. The first packet has no gap; late
/// timestamps never underflow.
fn update_gap(max_gap_ms: u64, last_packet_ms: Option<u64>, now_ms: u64) -> (u64, u64) {
    let gap_ms = last_packet_ms.map_or(0, |prev| now_ms.saturating_sub(prev));
    (max_gap_ms.max(gap_ms), now_ms)
}

// --- receive state ---

struct UserOut {
    file: File,
    /// Next sample position to write at (24 kHz samples, not bytes).
    cursor: u64,
    samples: u64,
    first_packet_ms: Option<u64>,
    last_packet_ms: Option<u64>,
    max_gap_ms: u64,
    /// Ticks where this user was scheduled but the RTP packet was lost.
    plc_ticks: u64,
    max_samples_per_tick: usize,
}

impl UserOut {
    fn open(user_id: u64) -> Self {
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(format!("spike-out/{user_id}.pcm"))
            .expect("create per-user pcm file");
        Self {
            file,
            cursor: 0,
            samples: 0,
            first_packet_ms: None,
            last_packet_ms: None,
            max_gap_ms: 0,
            plc_ticks: 0,
            max_samples_per_tick: 0,
        }
    }
}

struct Rx {
    start: Instant,
    ssrc_to_user: Mutex<HashMap<u32, u64>>,
    out: Mutex<HashMap<u64, UserOut>>,
}

impl Rx {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            ssrc_to_user: Mutex::new(HashMap::new()),
            out: Mutex::new(HashMap::new()),
        }
    }
}

/// `EventData::new` takes its handler by value and stores one copy per
/// registered event, so share the state through an `Arc` wrapper.
struct RxHandle(Arc<Rx>);

#[async_trait]
impl SongbirdEventHandler for RxHandle {
    async fn act(&self, ctx: &EventContext<'_>) -> Option<Event> {
        match ctx {
            EventContext::SpeakingStateUpdate(s) => {
                if let Some(user_id) = s.user_id {
                    self.0.ssrc_to_user.lock().await.insert(s.ssrc, user_id.0);
                }
            }
            EventContext::VoiceTick(t) => {
                let now_ms = self.0.start.elapsed().as_millis() as u64;
                let mut out = self.0.out.lock().await;
                let ssrcs = self.0.ssrc_to_user.lock().await;
                for (ssrc, data) in &t.speaking {
                    let Some(&user_id) = ssrcs.get(ssrc) else {
                        continue;
                    };
                    let entry = out.entry(user_id).or_insert_with(|| UserOut::open(user_id));

                    let state = WriteState {
                        cursor: entry.cursor,
                        last_packet_ms: entry.last_packet_ms,
                    };
                    let pcm_len = data.decoded_voice.as_ref().map_or(0, |p| p.len());
                    let Some(plan) = plan_write(state, data.packet.is_some(), pcm_len, now_ms)
                    else {
                        // Lost packet: songbird hands out a concealment frame
                        // (~80 ms at mono 24 kHz). Count it, never write it.
                        entry.plc_ticks += 1;
                        continue;
                    };
                    let pcm = data
                        .decoded_voice
                        .as_deref()
                        .expect("plan_write returned Some only for non-empty pcm");
                    let (max_gap_ms, last_packet_ms) =
                        update_gap(entry.max_gap_ms, entry.last_packet_ms, now_ms);
                    entry.max_gap_ms = max_gap_ms;
                    entry.last_packet_ms = Some(last_packet_ms);
                    if entry.first_packet_ms.is_none() {
                        entry.first_packet_ms = Some(now_ms);
                    }
                    let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
                    entry
                        .file
                        .write_all_at(&bytes, plan.write_at * 2)
                        .expect("write pcm");
                    entry.cursor = plan.new_cursor;
                    entry.samples += pcm.len() as u64;
                    entry.max_samples_per_tick = entry.max_samples_per_tick.max(pcm.len());
                }
            }
            _ => {}
        }
        None
    }
}

struct Handler {
    guild_id: GuildId,
    channel_id: ChannelId,
    rx: Arc<Rx>,
    joined: AtomicBool,
}

#[async_trait]
impl SerenityEventHandler for Handler {
    async fn ready(&self, ctx: Context, _ready: Ready) {
        if self.joined.swap(true, Ordering::SeqCst) {
            return;
        }
        let manager = songbird::get(&ctx)
            .await
            .expect("Songbird voice client registered at startup");
        let call = manager
            .join(self.guild_id, self.channel_id)
            .await
            .expect("voice channel join failed");
        let mut call = call.lock().await;
        call.deafen(false)
            .await
            .expect("failed to join without deafening");
        call.add_global_event(CoreEvent::VoiceTick.into(), RxHandle(self.rx.clone()));
        call.add_global_event(
            CoreEvent::SpeakingStateUpdate.into(),
            RxHandle(self.rx.clone()),
        );
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let token = std::env::var("SPIKE_DISCORD_TOKEN").expect("SPIKE_DISCORD_TOKEN not set");
    let guild_id = GuildId::new(
        std::env::var("SPIKE_GUILD_ID")
            .expect("SPIKE_GUILD_ID not set")
            .parse()?,
    );
    let channel_id = ChannelId::new(
        std::env::var("SPIKE_VOICE_CHANNEL_ID")
            .expect("SPIKE_VOICE_CHANNEL_ID not set")
            .parse()?,
    );
    let seconds: u64 = std::env::var("SPIKE_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120);

    fs::create_dir_all("spike-out")?;

    let rx = Arc::new(Rx::new());
    let mut client = songbird::register_from_config(
        serenity::Client::builder(
            &token,
            GatewayIntents::GUILDS | GatewayIntents::GUILD_VOICE_STATES,
        )
        .event_handler(Handler {
            guild_id,
            channel_id,
            rx: rx.clone(),
            joined: AtomicBool::new(false),
        }),
        Config::default().decode_mode(DecodeMode::Decode(DecodeConfig::new(
            Channels::Mono,
            SampleRate::Hz24000,
        ))),
    )
    .await?;

    let shard_manager = client.shard_manager.clone();
    tokio::spawn(async move {
        if let Err(e) = client.start().await {
            tracing::error!("gateway client error: {e:?}");
        }
    });

    tokio::time::sleep(Duration::from_secs(seconds)).await;
    shard_manager.shutdown_all().await;

    let out = rx.out.lock().await;
    let mut users: Vec<_> = out.iter().collect();
    users.sort_by_key(|(id, _)| *id);
    for (user_id, o) in users {
        let _ = o.file.sync_all();
        println!(
            "user={user_id} first_packet_ms={} samples={} max_gap_ms={} plc_ticks={} max_samples_per_tick={}",
            o.first_packet_ms.unwrap_or(0),
            o.samples,
            o.max_gap_ms,
            o.plc_ticks,
            o.max_samples_per_tick,
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 20 ms of mono 24 kHz audio, one typical Opus packet.
    const REAL_PACKET_LEN: usize = 480;

    fn state(cursor: u64, last_packet_ms: Option<u64>) -> WriteState {
        WriteState {
            cursor,
            last_packet_ms,
        }
    }

    #[test]
    fn lost_packet_tick_plans_no_write() {
        // A scripted tick with packet: None and 1920 decoded (concealment)
        // samples must not touch the timeline.
        assert_eq!(
            plan_write(state(48_000, Some(1_000)), false, 1920, 1_020),
            None
        );
    }

    #[test]
    fn empty_pcm_plans_no_write() {
        // A received packet with no decoded samples is never written.
        assert_eq!(plan_write(state(48_000, Some(1_000)), true, 0, 1_020), None);
    }

    #[test]
    fn first_packet_starts_utterance_at_wall_clock() {
        let plan = plan_write(state(0, None), true, REAL_PACKET_LEN, 200)
            .expect("first packet plans a write");
        assert_eq!(plan.write_at, 200 * SAMPLES_PER_MS);
        assert_eq!(plan.new_cursor, plan.write_at + REAL_PACKET_LEN as u64);
    }

    #[test]
    fn new_utterance_snaps_cursor_to_wall_clock() {
        // More than UTTERANCE_GAP_MS since the last written packet: the
        // cursor snaps forward past its stale position.
        let plan = plan_write(state(1_000, Some(0)), true, REAL_PACKET_LEN, 5_000)
            .expect("packet after silence plans a write");
        assert_eq!(plan.write_at, 5_000 * SAMPLES_PER_MS);
        assert_eq!(plan.new_cursor, plan.write_at + REAL_PACKET_LEN as u64);
    }

    #[test]
    fn inside_utterance_appends_contiguously() {
        // 5 ms after the previous packet with the cursor a few samples
        // behind the wall clock: the payload appends at the cursor, it does
        // not re-snap to the wall clock.
        let plan = plan_write(state(24_400, Some(1_015)), true, REAL_PACKET_LEN, 1_020)
            .expect("packet inside an utterance plans a write");
        assert_eq!(plan.write_at, 24_400);
        assert_eq!(plan.new_cursor, 24_880);
    }

    #[test]
    fn silence_of_exactly_the_gap_threshold_appends() {
        // The utterance rule is strictly `> UTTERANCE_GAP_MS`: 1000 ms of
        // silence is still inside the utterance.
        let plan = plan_write(state(10_000, Some(0)), true, REAL_PACKET_LEN, 1_000)
            .expect("write planned");
        assert_eq!(plan.write_at, 10_000);
    }

    #[test]
    fn gap_math_tracks_max_and_updates_last_seen() {
        // First packet: no gap.
        assert_eq!(update_gap(0, None, 500), (0, 500));
        // 200 ms since the last packet raises the max.
        assert_eq!(update_gap(0, Some(500), 700), (200, 700));
        // A shorter gap never lowers the max; late timestamps never underflow.
        assert_eq!(update_gap(400, Some(700), 500), (400, 500));
    }
}
